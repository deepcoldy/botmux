/**
 * Restore-time close decision for persistent backends (tmux/zellij/herdr/zmx).
 *
 * On daemon restart, restoreActiveSessions() re-registers every persisted active
 * session and then, for persistent backends, probes whether the backing
 * pane/agent survived. A *missing* backing is NEVER an auto-close trigger: the
 * CLI transcript on disk is still resumable, so the row is kept worker-less and
 * cold-resumes on the next message (mirrors pty, which has no backend to probe,
 * and zmx). This is the fix for the host-reboot mass-close bug — botmux shares
 * the default tmux socket with the operator's own terminal, so an earlier
 * serverState()-based gate that tried to tell a solo zombie apart from a reboot
 * was defeated by a co-tenant reviving the server, closing 239 live sessions
 * after one reboot. Only three things leave the active set on restore:
 *
 *   - missing  → KEEP the active record (no close, no fork) for lazy cold-resume
 *   - unknown  → KEEP the active record (no close, no fork) for lazy recovery
 *   - exists   → auto-fork to re-attach, no close
 *   - CLI mismatch → closeSession, so a worker-less old session cannot cold-resume
 *                    the wrong (config-switched) CLI. Orthogonal to backing state.
 *
 * (A real `/close` marks the store row 'closed' up front, so it is never in this
 * `active` restore set; a provably-exited adopt target is closed in the adopt
 * branch. Neither is exercised here.)
 *
 * Heavy collaborators are mocked at the module boundary; the session-store runs
 * for real against a temp dir, and the worker-pool mock faithfully reproduces
 * closeSession's eviction-from-the-live-Map + store-close mechanism (mirrors
 * session-resume.test.ts) so we assert the real eviction, not just end state.
 *
 * Run:  pnpm vitest run test/restore-zombie-close.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tempDir: string;

// Mutable probe verdict the mocked TmuxBackend returns this test run.
const probe = vi.hoisted(() => ({ result: 'exists' as 'exists' | 'missing' | 'unknown' }));
const zmxSnapshot = vi.hoisted(() => ({
  ok: true,
  sessions: [] as string[],
  unhealthySessions: [] as string[],
}));
const herdrProbe = vi.hoisted(() => ({ result: 'exists' as 'exists' | 'missing' | 'unknown' }));
// Mutable bot-side wrapperCli for the wrapper-axis mismatch tests.
const bot = vi.hoisted(() => ({
  cliId: 'claude-code' as import('../src/adapters/cli/types.js').CliId,
  cliRuntime: undefined as import('../src/adapters/cli/runtime.js').CliRuntimeConfig | undefined,
  cliPathOverride: undefined as string | undefined,
  wrapperCli: undefined as string | undefined,
}));

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
const transferState = vi.hoisted(() => ({
  active: new WeakSet<object>(),
  callbacks: new WeakMap<object, Set<() => void>>(),
}));

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(),
  forkAdoptWorker: vi.fn(),
  // Faithful union: any isolation source (live bot flag or the session's frozen
  // decision) blocks adopt. Mirrors the real predicate for the restore test.
  adoptSandboxBlocked: vi.fn((botCfg: any, session?: any) =>
    botCfg?.sandbox === true || botCfg?.readIsolation === true || session?.sandbox === true || process.env.BOTMUX_SANDBOX === '1'),
  killStalePids: vi.fn(),
  sweepDeadPidMarkers: vi.fn(),
  getActiveSessionsRegistry: vi.fn(() => wp.registry ?? undefined),
  isSessionTransferring: vi.fn((ds: object) => transferState.active.has(ds)),
  deferUntilSessionTransferSettled: vi.fn((ds: object, callback: () => void) => {
    if (!transferState.active.has(ds)) return false;
    const callbacks = transferState.callbacks.get(ds) ?? new Set<() => void>();
    callbacks.add(callback);
    transferState.callbacks.set(ds, callbacks);
    return true;
  }),
  getCurrentCliVersion: vi.fn(() => '1.0.0-test'),
  restoreUsageLimitRuntimeState: vi.fn(),
  withActiveSessionKeyLock: vi.fn(async (_map: Map<string, any>, _key: string, action: () => any) => action()),
  setActiveSessionSafe: vi.fn(async (map: Map<string, any>, key: string, ds: any) => {
    const prev = map.get(key);
    if (prev && prev !== ds) {
      const prevPending = (prev.session?.codexAppDispatchLedger?.length ?? 0) > 0;
      const incomingPending = (ds.session?.codexAppDispatchLedger?.length ?? 0) > 0;
      if (prevPending && incomingPending) {
        return {
          accepted: false,
          reason: 'both_pending',
          keptSessionId: prev.session.sessionId,
          preservedIncomingSessionId: ds.session.sessionId,
        };
      }
      const closeUnregistered = async (loser: any) => {
        for (const [k, v] of map) {
          if (v === loser) { map.delete(k); break; }
        }
        const store = await import('../src/services/session-store.js');
        const persisted = store.getSession(loser.session.sessionId);
        if (persisted && persisted.status !== 'closed') {
          store.closeSession(loser.session.sessionId);
        }
      };
      if (prevPending) {
        await closeUnregistered(ds);
        return {
          accepted: false,
          reason: 'kept_pending_owner',
          keptSessionId: prev.session.sessionId,
          closedIncomingSessionId: ds.session.sessionId,
        };
      }
      await closeUnregistered(prev);
    }
    map.set(key, ds);
    return {
      accepted: true,
      ...(prev && prev !== ds ? { closedSessionId: prev.session.sessionId } : {}),
    };
  }),
  // Faithful SYNCHRONOUS compare-and-set (mirrors production setActiveSessionIfActive):
  // resumeSession calls this inside withActiveSessionKeyLock, so it must not re-lock.
  // Inactive incoming drops its own stale entry → false; a different live occupant
  // wins → false; otherwise set → true.
  setActiveSessionIfActive: vi.fn((map: Map<string, any>, key: string, ds: any) => {
    if (ds?.session?.status !== 'active') {
      if (map.get(key) === ds) map.delete(key);
      return false;
    }
    const current = map.get(key);
    if (current && current !== ds) return false;
    map.set(key, ds);
    return true;
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
    if (s && s.status !== 'closed') {
      store.closeSession(sid, {
        ...(s.mojoCloseJournal?.phase === 'prepared'
          ? { clearRiffParentTaskId: true }
          : {}),
      });
    }
    return { ok: true, outcome: 'closed', alreadyClosed: false };
  }),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: {
      larkAppId: 'app_test',
      cliId: bot.cliId,
      cliRuntime: bot.cliRuntime,
      cliPathOverride: bot.cliPathOverride,
      wrapperCli: bot.wrapperCli,
      workingDir: '~',
      workingDirs: ['~'],
    },
    botName: 'TestBot',
    botOpenId: 'ou_test',
    resolvedAllowedUsers: [],
  })),
  getAllBots: vi.fn(() => [{
    config: { larkAppId: 'app_test', cliId: bot.cliId },
    botName: 'TestBot',
    botOpenId: 'ou_test',
    resolvedAllowedUsers: [],
  }]),
  getBotBrand: vi.fn(() => 'feishu'),
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
    killSession: vi.fn(),
  },
}));

vi.mock('../src/adapters/backend/herdr-backend.js', () => ({
  HerdrBackend: {
    sessionName: vi.fn((id: string) => `bmx-${id.slice(0, 8)}`),
    probeSession: vi.fn(() => herdrProbe.result),
    probeAgent: vi.fn(() => herdrProbe.result),
    killSession: vi.fn(),
    killAgent: vi.fn(),
  },
}));

vi.mock('../src/adapters/backend/zmx-backend.js', () => ({
  ZmxBackend: {
    sessionName: vi.fn((id: string) => `bmx-${id.slice(0, 8)}`),
    probeSession: vi.fn(() => probe.result),
    probeSessions: vi.fn(() => zmxSnapshot.ok ? {
      ok: true,
      sessions: [...zmxSnapshot.sessions],
      unhealthySessions: [...zmxSnapshot.unhealthySessions],
      raw: '',
    } : { ok: false }),
    hasSession: vi.fn(() => probe.result === 'exists'),
    killSession: vi.fn(),
    killManagedSession: vi.fn(),
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

import { restoreActiveSessions, closeCliMismatchedSessionsForBot, resumeSession,
} from '../src/core/session-manager.js';
import { getAllBots, getBot } from '../src/bot-registry.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { HerdrBackend } from '../src/adapters/backend/herdr-backend.js';
import { ZmxBackend } from '../src/adapters/backend/zmx-backend.js';
import {
  closeSession,
  forkAdoptWorker,
  forkWorker,
  setActiveSessionSafe,
} from '../src/core/worker-pool.js';
import { announceSessionRow } from '../src/core/session-activity.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import * as sessionStore from '../src/services/session-store.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import { logger } from '../src/utils/logger.js';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'restore-zombie-test-'));
  sessionStore.init();
  wp.registry = null;
  transferState.active = new WeakSet<object>();
  transferState.callbacks = new WeakMap<object, Set<() => void>>();
  probe.result = 'exists';
  zmxSnapshot.ok = true;
  zmxSnapshot.sessions = [];
  zmxSnapshot.unhealthySessions = [];
  herdrProbe.result = 'exists';
  bot.cliId = 'claude-code';
  bot.cliRuntime = undefined;
  bot.cliPathOverride = undefined;
  bot.wrapperCli = undefined;
  vi.mocked(closeSession).mockClear();
  vi.mocked(forkWorker).mockClear();
  vi.mocked(announceSessionRow).mockClear();
  vi.mocked(ZmxBackend.probeSessions).mockClear();
  vi.mocked(ZmxBackend.killManagedSession).mockReset();
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeActivePersistentSession(rootMessageId: string, backendType: 'tmux' | 'zmx' = 'tmux') {
  const s = sessionStore.createSession('oc_chat1', rootMessageId, 'Topic', 'group');
  s.larkAppId = 'app_test';
  s.workingDir = '/tmp/proj';
  s.cliId = bot.cliId;
  s.scope = 'thread';
  // Real tmux sessions now carry their backend stamped at spawn time
  // (Session.backendType); getSessionPersistentBackendType reads it back rather
  // than re-deriving from the daemon default. Stamp it so this fixture models a
  // genuine tmux-backed session.
  s.backendType = backendType;
  sessionStore.updateSession(s);
  return s; // left active
}

describe('restoreActiveSessions — mojo identity freeze attribution (P0-4)', () => {
  // The module-level bot-registry mock serves every other describe; stash its
  // implementations so these tests can swap in their own without leaking.
  let origGetAllBots: (() => unknown) | undefined;
  let origGetBot: (() => unknown) | undefined;
  beforeEach(() => {
    origGetAllBots = vi.mocked(getAllBots).getMockImplementation();
    origGetBot = vi.mocked(getBot).getMockImplementation();
  });
  afterEach(() => {
    vi.mocked(getAllBots).mockImplementation(origGetAllBots as never);
    vi.mocked(getBot).mockImplementation(origGetBot as never);
  });

  it('never guesses a tenant for a legacy row without larkAppId when several bots are registered', async () => {
    // Pre-fix, restore fell back to getAllBots()[0]: with a mojo bot in slot 0,
    // an unattributed legacy row (no backendType/cliId stamped) was classified
    // mojo AGAINST THAT BOT — its riff lineage parked into
    // mojoQuarantinedLineage and bot[0]'s tenant identity frozen on. The freeze
    // is idempotent, so one wrong boot locked the misbinding in durably.
    vi.mocked(getAllBots).mockReturnValue([
      { config: { larkAppId: 'app_mojo', backendType: 'mojo', mojo: { cloud: true } } },
      { config: { larkAppId: 'app_test', cliId: 'claude-code' } },
    ] as never);
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: 'app_mojo', backendType: 'mojo', mojo: { cloud: true } },
      botName: 'MojoBot', botOpenId: 'ou_mojo', resolvedAllowedUsers: [],
    } as never);
    const s = sessionStore.createSession('oc_chat1', 'om_legacy_no_app', 'Topic', 'group');
    // A pre-larkAppId row: nothing stamped, only a remote lineage left behind.
    s.larkAppId = undefined;
    s.backendType = undefined;
    s.cliId = undefined;
    s.riffParentTaskId = 'legacy-task-1';
    sessionStore.updateSession(s);
    sessionStore.init();
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    const after = sessionStore.getSession(s.sessionId);
    // Unfrozen (`undefined` keeps meaning "predates this field"), lineage kept.
    expect(after?.mojoIdentity).toBeUndefined();
    expect(after?.mojoQuarantinedLineage).toBeUndefined();
    expect(after?.riffParentTaskId).toBe('legacy-task-1');
  });

  it('still freezes via the single registered bot when attribution is unambiguous', async () => {
    vi.mocked(getAllBots).mockReturnValue([
      { config: { larkAppId: 'app_mojo', backendType: 'mojo', mojo: { cloud: true } } },
    ] as never);
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: 'app_mojo', backendType: 'mojo', mojo: { cloud: true } },
      botName: 'MojoBot', botOpenId: 'ou_mojo', resolvedAllowedUsers: [],
    } as never);
    const s = sessionStore.createSession('oc_chat1', 'om_legacy_single_bot', 'Topic', 'group');
    s.larkAppId = undefined;
    s.backendType = undefined;
    s.cliId = undefined;
    sessionStore.updateSession(s);
    sessionStore.init();
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    // One bot means the row can only belong to it: frozen, not left migratable.
    expect(sessionStore.getSession(s.sessionId)?.mojoIdentity).toEqual({ cloud: true });
  });
});

describe('restoreActiveSessions — persistent-backend zombie-close decision', () => {
  it('finishes a durable prepared Mojo close without registering or re-cancelling', async () => {
    const s = makeActivePersistentSession('om_mojo_prepared_recovery');
    s.backendType = 'mojo';
    s.riffParentTaskId = 'mojo-prepared-id';
    s.mojoIdentity = { cloud: true };
    s.mojoCloseJournal = {
      phase: 'prepared',
      requestId: 'close-before-crash',
      taskId: 'mojo-prepared-id',
      updatedAt: new Date().toISOString(),
    };
    sessionStore.updateSession(s);
    sessionStore.init();
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(closeSession).toHaveBeenCalledWith(s.sessionId);
    expect(map.size).toBe(0);
    expect(forkWorker).not.toHaveBeenCalled();
    expect(sessionStore.getSession(s.sessionId)).toMatchObject({ status: 'closed' });
    expect(sessionStore.getSession(s.sessionId)?.riffParentTaskId).toBeUndefined();
    expect(sessionStore.getSession(s.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('does NOT downgrade a COMMIT-ONLY prepared close into an uncertain fence', async () => {
    // Liveness guard for a load-bearing branch ORDER. The `phase === 'prepared'`
    // branch must run BEFORE the catch-all that rebuilds any remaining journal as
    // `uncertain` + fenced. If the two are ever reordered, an irreversible
    // teardown (remote side already gone, only the local commit outstanding) is
    // rewritten as "needs manual reconciliation" and its local commit can never
    // complete again -- the session is wedged open forever, still holding its
    // device-isolation blocker.
    const s = makeActivePersistentSession('om_mojo_commit_only_recovery');
    s.backendType = 'mojo';
    s.riffParentTaskId = 'mojo-commit-only-id';
    s.mojoIdentity = { cloud: true };
    s.mojoCloseJournal = {
      phase: 'prepared',
      requestId: 'close-before-crash',
      taskId: 'mojo-commit-only-id',
      recovery: 'irreversible',
      admission: 'fenced',
      commitOnly: true,
      updatedAt: new Date().toISOString(),
    };
    sessionStore.updateSession(s);
    sessionStore.init();
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    // The local commit ran: row closed, journal cleared, nothing re-cancelled.
    expect(closeSession).toHaveBeenCalledWith(s.sessionId);
    expect(sessionStore.getSession(s.sessionId)).toMatchObject({ status: 'closed' });
    const after = sessionStore.getSession(s.sessionId);
    expect(after?.mojoCloseJournal).toBeUndefined();
    // And specifically NOT the downgrade the catch-all would have written.
    expect(after?.mojoCloseJournal?.phase).not.toBe('uncertain');
    expect(map.size).toBe(0);
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('keeps a prepared close quarantined when a parked residual still needs a user surface', async () => {
    const s = makeActivePersistentSession('om_mojo_prepared_residual');
    s.backendType = 'mojo';
    s.riffParentTaskId = 'mojo-active-cancelled';
    s.mojoQuarantinedLineage = 'mojo-parked-manual';
    s.mojoQuarantineNoticePending = true;
    s.mojoIdentity = { cloud: true };
    s.mojoCloseJournal = {
      phase: 'prepared',
      requestId: 'close-before-crash',
      taskId: 'mojo-active-cancelled',
      updatedAt: new Date().toISOString(),
    };
    sessionStore.updateSession(s);
    sessionStore.init();
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(closeSession).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
    expect(sessionStore.getSession(s.sessionId)).toMatchObject({
      status: 'active',
      restoreQuarantinedAt: expect.any(String),
      mojoQuarantinedLineage: 'mojo-parked-manual',
      mojoCloseJournal: { phase: 'prepared' },
    });
  });

  it('quarantines an interrupted Mojo prepare and never registers or forks it', async () => {
    const s = makeActivePersistentSession('om_mojo_uncertain_recovery');
    s.backendType = 'mojo';
    s.riffParentTaskId = 'mojo-uncertain-id';
    s.mojoIdentity = { cloud: true };
    s.mojoCloseJournal = {
      phase: 'preparing',
      requestId: 'close-interrupted',
      taskId: 'mojo-uncertain-id',
      updatedAt: new Date().toISOString(),
    };
    sessionStore.updateSession(s);
    sessionStore.init();
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(closeSession).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
    expect(forkWorker).not.toHaveBeenCalled();
    expect(sessionStore.getSession(s.sessionId)).toMatchObject({
      status: 'active',
      restoreQuarantinedAt: expect.any(String),
      mojoCloseJournal: {
        phase: 'uncertain',
        requestId: 'close-interrupted',
        taskId: 'mojo-uncertain-id',
      },
    });
  });

  it('quarantines a Mojo journal stamped onto another backend instead of closing it', async () => {
    const s = makeActivePersistentSession('om_invalid_mojo_journal', 'riff');
    s.riffParentTaskId = 'riff-task-must-survive';
    s.mojoCloseJournal = {
      phase: 'prepared',
      requestId: 'invalid-cross-backend-proof',
      taskId: 'riff-task-must-survive',
      updatedAt: new Date().toISOString(),
    };
    sessionStore.updateSession(s);
    sessionStore.init();
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(closeSession).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
    expect(forkWorker).not.toHaveBeenCalled();
    expect(sessionStore.getSession(s.sessionId)).toMatchObject({
      status: 'active',
      backendType: 'riff',
      riffParentTaskId: 'riff-task-must-survive',
      restoreQuarantinedAt: expect.any(String),
      mojoCloseJournal: { phase: 'uncertain' },
    });
  });

  it('quarantines a malformed prepared journal instead of treating it as proof', async () => {
    const s = makeActivePersistentSession('om_malformed_mojo_journal');
    s.backendType = 'mojo';
    s.riffParentTaskId = 'mojo-must-not-be-cleared';
    s.mojoIdentity = { cloud: true };
    s.mojoCloseJournal = {
      phase: 'prepared',
      requestId: '',
      taskId: 'mojo-must-not-be-cleared',
      updatedAt: '',
    };
    sessionStore.updateSession(s);
    sessionStore.init();
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(closeSession).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
    expect(forkWorker).not.toHaveBeenCalled();
    expect(sessionStore.getSession(s.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'mojo-must-not-be-cleared',
      restoreQuarantinedAt: expect.any(String),
      mojoCloseJournal: { phase: 'prepared', requestId: '' },
    });
  });

  it('shared Herdr restore probes the recorded managed agent, not a derived bmx-* session', async () => {
    const s = makeActivePersistentSession('om_shared_herdr');
    s.backendType = 'herdr';
    s.persistentBackendTarget = {
      backendType: 'herdr',
      sessionName: 'work',
      agentName: `botmux-${s.sessionId.slice(0, 8)}`,
    };
    sessionStore.updateSession(s);
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(HerdrBackend.probeAgent).toHaveBeenCalledWith(
      'work',
      `botmux-${s.sessionId.slice(0, 8)}`,
    );
    expect(HerdrBackend.probeSession).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(forkWorker).toHaveBeenCalledWith(expect.objectContaining({ session: s }), '', true);
  });

  it('isolates a collision-loser close refusal and continues restoring later rows', async () => {
    const blocked = makeActivePersistentSession('om_collision_blocked', 'zmx');
    const survivor = makeActivePersistentSession('om_collision_survivor', 'tmux');
    const map = new Map<string, DaemonSession>();
    wp.registry = map;
    vi.mocked(setActiveSessionSafe).mockResolvedValueOnce(false);
    vi.mocked(closeSession).mockRejectedValueOnce(new Error('ownership probe unavailable'));

    await expect(restoreActiveSessions(map)).resolves.toBeUndefined();

    expect(closeSession).toHaveBeenCalledWith(blocked.sessionId);
    expect(sessionStore.getSession(blocked.sessionId)?.status).toBe('active');
    expect(sessionStore.getSession(blocked.sessionId)?.restoreQuarantinedAt).toEqual(expect.any(String));
    expect(map.get(sessionKey('om_collision_blocked', 'app_test'))).toBeUndefined();
    expect(map.get(sessionKey('om_collision_survivor', 'app_test'))?.session.sessionId).toBe(survivor.sessionId);
    expect(forkWorker).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ sessionId: survivor.sessionId }) }),
      '',
      true,
    );
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ownership probe unavailable'));
  });

  it('"missing" → keeps the active record for lazy cold-resume, does NOT close', async () => {
    // A missing backing pane is never an auto-close trigger for a managed
    // session: whether one pane crashed or the whole server is gone, the CLI
    // transcript on disk is still resumable, so the worker-less active record is
    // kept and the next message cold-resumes it. Mirrors pty (never probed) and
    // zmx (missing always kept). Only a real /close, a provably-exited adopt
    // target, or a CLI-config mismatch leaves the active set.
    probe.result = 'missing';
    const s = makeActivePersistentSession('om_missing');
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(announceSessionRow).toHaveBeenCalledTimes(1);
    expect(announceSessionRow).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ sessionId: s.sessionId }),
    }));
    expect(closeSession).not.toHaveBeenCalled();
    const ds = map.get(sessionKey('om_missing', 'app_test'));
    expect(ds).toBeDefined();              // active record retained…
    expect(ds!.worker).toBeNull();         // …worker-less, cold-resumes on next message
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('active'); // NOT closed
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('"missing" after a host reboot (server gone) → keeps the active record, does NOT close', async () => {
    // The reboot bug this whole fix targets: a host reboot wipes the tmux
    // server, so every bmx-* pane probes 'missing' at once. Because botmux
    // shares the default tmux socket with the operator's own terminal, a
    // co-tenant reviving the server before restore ran made the old
    // serverState() gate read the reboot as N solo zombies → mass-close (239
    // sessions after one reboot). Now 'missing' is never an auto-close: the
    // CLI transcript on disk is still resumable, so the row is kept worker-less
    // and cold-resumes on the next message, exactly like a pty session.
    probe.result = 'missing';
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

  it('missing ZMX session stays lazy-recoverable even when another ZMX daemon is running', async () => {
    probe.result = 'missing';
    const s = makeActivePersistentSession('om_zmx_missing', 'zmx');
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(closeSession).not.toHaveBeenCalled();
    expect(map.get(sessionKey('om_zmx_missing', 'app_test'))).toBeDefined();
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('active');
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('classifies multiple ZMX restore rows from one full-list snapshot', async () => {
    const first = makeActivePersistentSession('om_zmx_batch_1', 'zmx');
    const second = makeActivePersistentSession('om_zmx_batch_2', 'zmx');
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(ZmxBackend.probeSessions).toHaveBeenCalledTimes(1);
    expect(sessionStore.getSession(first.sessionId)!.status).toBe('active');
    expect(sessionStore.getSession(second.sessionId)!.status).toBe('active');
    expect(closeSession).not.toHaveBeenCalled();
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('CLI mismatch on restore → closes the active record even though a missing backing is normally kept', async () => {
    // This is the config-switch case: the bot now points at a different CLI,
    // but an old active session still has its original cliId frozen. A missing
    // backing is normally kept for lazy resume, but a mismatch must still close:
    // otherwise the next @mention would cold-resume the OLD CLI instead of
    // creating a clean session with the current bot config. Mismatch-close is
    // orthogonal to whether the backing pane survived.
    probe.result = 'missing';
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

  it('CLI mismatch on restore preserves and reattaches an unsettled Codex App ledger', async () => {
    probe.result = 'exists';
    const s = makeActivePersistentSession('om_cli_mismatch_pending');
    s.cliId = 'codex-app';
    s.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-pending',
      turnId: 'turn-pending',
      state: 'prepared',
      content: 'prompt',
      deliverySink: 'lark',
    }];
    sessionStore.updateSession(s);
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(closeSession).not.toHaveBeenCalled();
    expect(sessionStore.getSession(s.sessionId)).toMatchObject({
      status: 'active',
      codexAppDispatchLedger: [{ dispatchId: 'dispatch-pending' }],
    });
    const restored = map.get(sessionKey('om_cli_mismatch_pending', 'app_test'));
    expect(restored).toBeDefined();
    expect(forkWorker).toHaveBeenCalledWith(restored, '', true);
  });

  it('isolates a failed ZMX mismatch teardown and continues closing later sessions', async () => {
    const blocked = makeActivePersistentSession('om_zmx_mismatch_blocked', 'zmx');
    blocked.cliId = 'codex';
    sessionStore.updateSession(blocked);
    const closable = makeActivePersistentSession('om_zmx_mismatch_closable', 'zmx');
    closable.cliId = 'codex';
    sessionStore.updateSession(closable);
    vi.mocked(ZmxBackend.killManagedSession)
      .mockImplementationOnce(() => { throw new Error('ownership probe unavailable'); })
      .mockImplementationOnce(() => undefined);
    const map = new Map<string, DaemonSession>();
    wp.registry = map;
    const events: any[] = [];
    const off = dashboardEventBus.subscribe(event => events.push(event));

    try {
      await expect(restoreActiveSessions(map)).resolves.toBeUndefined();
    } finally {
      off();
    }

    expect(ZmxBackend.killManagedSession).toHaveBeenNthCalledWith(
      1,
      `bmx-${blocked.sessionId.slice(0, 8)}`,
      blocked.sessionId,
    );
    expect(ZmxBackend.killManagedSession).toHaveBeenNthCalledWith(
      2,
      `bmx-${closable.sessionId.slice(0, 8)}`,
      closable.sessionId,
    );
    expect(sessionStore.getSession(blocked.sessionId)?.status).toBe('active');
    expect(sessionStore.getSession(blocked.sessionId)?.restoreQuarantinedAt).toEqual(expect.any(String));
    expect(sessionStore.getSession(closable.sessionId)?.status).toBe('closed');
    expect(closeSession).toHaveBeenCalledWith(closable.sessionId);
    expect(closeSession).not.toHaveBeenCalledWith(blocked.sessionId);
    expect(events).toContainEqual({
      type: 'session.spawned',
      body: {
        session: expect.objectContaining({
          sessionId: blocked.sessionId,
          status: 'dormant',
          quarantined: true,
        }),
      },
    });
    // The uncertain row remains retryable on disk but is not registered or
    // reattached into the live map with its now-mismatched CLI.
    expect(map.size).toBe(0);
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('keeps a deferred ZMX row active when teardown is uncertain and restores later rows', async () => {
    const hidden = makeActivePersistentSession('om_deferred_zmx_blocked', 'zmx');
    hidden.deferredScheduleRun = {
      taskId: 'task-hidden',
      turnId: 'schedule:task-hidden:run-1',
      routingAnchor: 'schedule-run:task-hidden:run-1',
      createdAt: '2026-07-21T00:00:00.000Z',
    };
    sessionStore.updateSession(hidden);
    const survivor = makeActivePersistentSession('om_restore_after_blocked');
    sessionStore.updateSession(survivor);
    vi.mocked(ZmxBackend.killManagedSession)
      .mockImplementationOnce(() => { throw new Error('kill confirmation timed out'); });
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await expect(restoreActiveSessions(map)).resolves.toBeUndefined();

    expect(sessionStore.getSession(hidden.sessionId)?.status).toBe('active');
    expect(sessionStore.getSession(hidden.sessionId)?.restoreQuarantinedAt).toEqual(expect.any(String));
    expect(closeSession).not.toHaveBeenCalledWith(hidden.sessionId);
    expect(map.get(sessionKey('om_deferred_zmx_blocked', 'app_test'))).toBeUndefined();
    expect(sessionStore.getSession(survivor.sessionId)?.status).toBe('active');
    expect(map.get(sessionKey('om_restore_after_blocked', 'app_test'))?.session.sessionId).toBe(survivor.sessionId);
    expect(forkWorker).toHaveBeenCalledTimes(1);
  });

  it('wrapper mismatch on restore (same cliId) → closes the active record', async () => {
    // 'aiden x claude' and bare claude-code share cliId='claude-code' but are
    // distinct launch choices (selectionKeyForBot keys on cliId+wrapperCli).
    // A frozen wrapper snapshot that differs from the bot's current wrapper is
    // the same config-switch case as a cliId change and must close too.
    probe.result = 'missing';
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

  it('quarantines a restore whose CLI-mismatch close was REFUSED (not thrown)', async () => {
    // A refused close is a returned {ok:false}, so it never reaches the catch that
    // quarantines a thrown one. Without an explicit branch the row stays active on
    // disk yet is never registered — an owner that IM /close cannot reach, while a
    // later inbound on the same anchor mints a second session and the old remote
    // one keeps running.
    probe.result = 'missing';
    const blocked = makeActivePersistentSession('om_close_refused');
    blocked.wrapperCli = 'aiden x claude';
    blocked.agentFrozen = true;
    sessionStore.updateSession(blocked);
    const survivor = makeActivePersistentSession('om_restore_after_refusal', 'tmux');
    sessionStore.updateSession(survivor);
    vi.mocked(closeSession).mockResolvedValueOnce({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_cancel_failed',
      retryable: true,
      taskId: 'mojo-sid-123',
    } as never);
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await expect(restoreActiveSessions(map)).resolves.toBeUndefined();

    expect(closeSession).toHaveBeenCalledWith(blocked.sessionId);
    // Row kept active AND quarantined, so it is visible as a problem rather than
    // silently invisible.
    expect(sessionStore.getSession(blocked.sessionId)?.status).toBe('active');
    expect(sessionStore.getSession(blocked.sessionId)?.restoreQuarantinedAt)
      .toEqual(expect.any(String));
    expect(map.get(sessionKey('om_close_refused', 'app_test'))).toBeUndefined();
    // Unrelated rows still restore.
    expect(map.get(sessionKey('om_restore_after_refusal', 'app_test'))?.session.sessionId)
      .toBe(survivor.sessionId);
  });

  it('frozen wrapper matching the bot wrapper → NOT a mismatch, session kept', async () => {
    probe.result = 'missing';
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

  it('"missing" for every session (host reboot) → keeps ALL of them (no mass-close)', async () => {
    probe.result = 'missing';
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

  it('"missing" for a cap-suspended session → keeps active for cold-resume', async () => {
    // The idle-worker sweeper deliberately kills a session's backing pane + CLI
    // over the per-bot cap, leaving suspendedColdResume set. Its backing probes
    // 'missing' on restart; like every other missing managed backing it is kept
    // worker-less and cold-resumes from the transcript on the next message.
    probe.result = 'missing';
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

  // ── blocker #3d: a sandbox session persisted as adopt must be CONVERTED to a
  // plain cold-start at restore, not re-registered as a (worker=null) adopt. ──
  it('sandbox adopt session on restore → converted to cold-start (no adopt fork, title normalized, row not adopt, survives next restart)', async () => {
    probe.result = 'exists';
    const s = makeActivePersistentSession('om_sbx_adopt');
    s.sandbox = true; // frozen sandbox decision
    s.title = 'Adopt: proj';
    s.adoptedFrom = { source: 'tmux', tmuxTarget: 'ext:0.0', originalCliPid: 111, cliId: 'claude-code', cwd: '/tmp/proj' } as any;
    sessionStore.updateSession(s);
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    // NOT adopted: no adopt fork, persisted metadata cleared, title normalized
    expect(forkAdoptWorker).not.toHaveBeenCalled();
    const persisted = sessionStore.getSession(s.sessionId)!;
    expect(persisted.adoptedFrom).toBeUndefined();
    expect(persisted.title).not.toMatch(/^Adopt:/);
    // registered as an ordinary restored session (row announced, not closed)
    expect(closeSession).not.toHaveBeenCalledWith(s.sessionId);
    const restored = map.get(sessionKey('om_sbx_adopt', 'app_test'));
    expect(restored).toBeDefined();
    expect(restored!.adoptedFrom).toBeUndefined();

    // A SECOND restart must not hit the legacy title-only "Adopt:" close branch
    // (the bug: title still started with "Adopt:" after metadata was cleared).
    const map2 = new Map<string, DaemonSession>();
    wp.registry = map2;
    vi.mocked(closeSession).mockClear();
    await restoreActiveSessions(map2);
    expect(closeSession).not.toHaveBeenCalledWith(s.sessionId);
    expect(map2.get(sessionKey('om_sbx_adopt', 'app_test'))).toBeDefined();
  });

  it('restores only the latest clean Codex App sidecar after a disk reload and re-attaches it', async () => {
    probe.result = 'exists';
    bot.cliId = 'codex-app';
    const s = makeActivePersistentSession('om_codex_sidecar_restore');

    for (let round = 1; round <= 20; round++) {
      s.lastUserPrompt = `第 ${round} 轮用户原文`;
      s.lastCliInput = `<user_message>第 ${round} 轮用户原文</user_message>`;
      s.lastCodexAppInput = {
        text: `第 ${round} 轮用户原文`,
        clientUserMessageId: `om_round_${round}`,
        additionalContext: {
          botmux_sender: { kind: 'untrusted', value: `<sender round="${round}" />` },
          botmux_role: { kind: 'application', value: '<role>经营助手</role>' },
        },
        localImages: [{ path: `/tmp/round-${round}.png`, detail: 'original' }],
      };
      sessionStore.updateSession(s);
    }
    const expected = structuredClone(s.lastCodexAppInput);

    // Simulate a fresh daemon process: discard the in-memory store and reload
    // the active session from sessions.json before restoring workers.
    sessionStore.init();
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    const restored = map.get(sessionKey('om_codex_sidecar_restore', 'app_test'))!;
    expect(restored.lastCodexAppInput).toEqual(expected);
    expect(restored.session.lastCodexAppInput).toEqual(expected);
    expect(restored.lastUserPrompt).toBe('第 20 轮用户原文');
    expect(restored.lastCliInput).toContain('第 20 轮用户原文');
    expect(forkWorker).toHaveBeenCalledWith(restored, '', true);
    expect(sessionStore.getSession(s.sessionId)?.lastCodexAppInput).toEqual(expected);
  });

  it('isolates a same-anchor pending collision without aborting startup and preserves both rows', async () => {
    probe.result = 'exists';
    bot.cliId = 'codex-app';
    const first = makeActivePersistentSession('om_pending_collision');
    first.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-first',
      turnId: 'turn-first',
      state: 'prepared',
      content: 'first owned output',
      deliverySink: 'lark',
    }];
    sessionStore.updateSession(first);
    const second = makeActivePersistentSession('om_pending_collision');
    second.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-second',
      turnId: 'turn-second',
      state: 'prepared',
      content: 'second owned output',
      deliverySink: 'lark',
    }];
    sessionStore.updateSession(second);
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await expect(restoreActiveSessions(map)).resolves.toBeUndefined();

    expect(sessionStore.getSession(first.sessionId)?.status).toBe('active');
    expect(sessionStore.getSession(second.sessionId)?.status).toBe('active');
    expect(closeSession).not.toHaveBeenCalled();
    const canonical = map.get(sessionKey('om_pending_collision', 'app_test'))!;
    expect(canonical.session.sessionId).toBe(first.sessionId);
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(forkWorker).toHaveBeenCalledWith(canonical, '', true);
  });
});

describe('resumeSession — disk-only legacy anchor collision', () => {
  it('refuses a legacy unscoped real owner instead of ghosting it', async () => {
    const target = makeActivePersistentSession('om_resume_legacy_conflict');
    sessionStore.closeSession(target.sessionId);
    const legacyOwner = makeActivePersistentSession('om_resume_legacy_conflict');
    legacyOwner.larkAppId = undefined;
    legacyOwner.lastCliInput = 'existing conversation';
    sessionStore.updateSession(legacyOwner);
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    const result = await resumeSession(target.sessionId, map);

    expect(result).toEqual({
      ok: false,
      error: 'anchor_occupied',
      activeSessionId: legacyOwner.sessionId,
    });
    expect(sessionStore.getSession(target.sessionId)?.status).toBe('closed');
    expect(sessionStore.getSession(legacyOwner.sessionId)?.status).toBe('active');
    expect(map.size).toBe(0);
  });

  it('closes a disk-only legacy scratch before reactivating the requested session', async () => {
    const target = makeActivePersistentSession('om_resume_legacy_scratch');
    sessionStore.closeSession(target.sessionId);
    const legacyScratch = makeActivePersistentSession('om_resume_legacy_scratch');
    legacyScratch.larkAppId = undefined;
    legacyScratch.cliId = undefined;
    legacyScratch.lastCliInput = undefined;
    sessionStore.updateSession(legacyScratch);
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    const result = await resumeSession(target.sessionId, map);

    expect(result.ok).toBe(true);
    expect(sessionStore.getSession(legacyScratch.sessionId)?.status).toBe('closed');
    expect(sessionStore.getSession(target.sessionId)?.status).toBe('active');
    expect(map.get(sessionKey('om_resume_legacy_scratch', 'app_test'))?.session.sessionId)
      .toBe(target.sessionId);
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

    expect(closed).toMatchObject({ closed: 1 });
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

    expect(await closeCliMismatchedSessionsForBot('app_test'))
      .toMatchObject({ closed: 1 });
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('closed');
  });

  it('counts a close that left an uncancelled remote session', async () => {
    // A hot CLI/backend switch can hit an old mojo row carrying a parked lineage.
    // This sweep has no interactive surface, so the count is the only way the
    // dashboard can avoid reporting those as fully torn down.
    const s = makeActivePersistentSession('om_rt_residual');
    s.wrapperCli = 'aiden x claude';
    s.agentFrozen = true;
    sessionStore.updateSession(s);
    registerDs(s);
    vi.mocked(closeSession).mockResolvedValueOnce({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-parked-9' },
      alreadyClosed: false,
      known: true,
    } as never);

    expect(await closeCliMismatchedSessionsForBot('app_test'))
      .toMatchObject({ closed: 1, residual: 1 });
  });

  it('does NOT count a refused close as closed, and keeps the row + owner', async () => {
    // closeSession models a refused close as a RETURNED {ok:false}, not a throw.
    // Counting it as `closed` reported a green "closed N" for a row that is still
    // active — and whose remote session may still be running.
    const s = makeActivePersistentSession('om_rt_refused');
    s.wrapperCli = 'aiden x claude';
    s.agentFrozen = true;
    sessionStore.updateSession(s);
    const ds = registerDs(s);
    vi.mocked(closeSession).mockResolvedValueOnce({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_cancel_failed',
      retryable: true,
      taskId: 'mojo-sid-123',
    } as never);

    expect(await closeCliMismatchedSessionsForBot('app_test'))
      .toMatchObject({ closed: 0, residual: 0, failed: 1 });
    // The row stays active and keeps its owner so the close can be retried.
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('active');
    expect(wp.registry?.size ?? 0).toBeGreaterThan(0);
    void ds;
  });

  it('counts a THROWN close as failed and keeps sweeping later rows', async () => {
    // The catch used to swallow the error without counting it, so a sweep that
    // threw on every row still reported a clean "closed 0, failed 0".
    const boom = makeActivePersistentSession('om_rt_throw');
    boom.wrapperCli = 'aiden x claude';
    boom.agentFrozen = true;
    sessionStore.updateSession(boom);
    registerDs(boom);
    const later = makeActivePersistentSession('om_rt_after_throw');
    later.wrapperCli = 'aiden x claude';
    later.agentFrozen = true;
    sessionStore.updateSession(later);
    registerDs(later);
    vi.mocked(closeSession).mockRejectedValueOnce(new Error('ownership probe unavailable'));

    const result = await closeCliMismatchedSessionsForBot('app_test');

    expect(result.failed).toBe(1);
    // The sweep continued: the second row was still closed.
    expect(result.closed).toBe(1);
    expect(closeSession).toHaveBeenCalledWith(later.sessionId);
  });

  it('closes runtime identity mismatches and describes both distributions in the warning', async () => {
    bot.cliId = 'codex';
    bot.cliRuntime = {
      id: 'current-codex',
      displayName: 'Current Codex',
      executable: '/opt/current-codex',
      update: { provider: 'none' },
    };
    bot.cliPathOverride = '/opt/current-codex';
    const s = makeActivePersistentSession('om_rt_runtime_mismatch');
    s.agentFrozen = true;
    s.cliRuntime = {
      id: 'frozen-codex',
      displayName: 'Frozen Codex',
      executable: '/opt/frozen-codex',
      source: 'configured',
      update: { provider: 'self' },
    };
    s.cliPathOverride = '/opt/frozen-codex';
    sessionStore.updateSession(s);
    registerDs(s);

    expect(await closeCliMismatchedSessionsForBot('app_test'))
      .toMatchObject({ closed: 1 });
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('closed');
    const warnings = vi.mocked(logger.warn).mock.calls.flat().join('\n');
    expect(warnings).toContain('session=Frozen Codex');
    expect(warnings).toContain('bot=Current Codex');
  });

  it('closes an old frozen path when its source differs from a configured runtime with the same id', async () => {
    bot.cliId = 'codex';
    bot.cliRuntime = {
      id: 'vendor-codex',
      displayName: 'VendorCodex',
      executable: '/opt/new-location/vendor-codex',
      update: { provider: 'self' },
    };
    bot.cliPathOverride = '/opt/new-location/vendor-codex';
    const s = makeActivePersistentSession('om_rt_legacy_runtime_match');
    s.agentFrozen = true;
    s.cliPathOverride = '/opt/old-location/vendor-codex';
    sessionStore.updateSession(s);
    registerDs(s);

    expect(await closeCliMismatchedSessionsForBot('app_test'))
      .toMatchObject({ closed: 1 });
    expect(closeSession).toHaveBeenCalledWith(s.sessionId);
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('closed');
  });

  it('does not treat a legacy executable named codex as the official runtime', async () => {
    bot.cliId = 'codex';
    bot.cliRuntime = undefined;
    bot.cliPathOverride = undefined;
    const s = makeActivePersistentSession('om_rt_legacy_codex');
    s.agentFrozen = true;
    s.cliPathOverride = 'codex';
    sessionStore.updateSession(s);
    registerDs(s);

    expect(await closeCliMismatchedSessionsForBot('app_test'))
      .toMatchObject({ closed: 1 });
    expect(closeSession).toHaveBeenCalledWith(s.sessionId);
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('closed');
  });

  it('does not compare runtime identity before a legacy session is agentFrozen', async () => {
    bot.cliId = 'codex';
    bot.cliRuntime = {
      id: 'current-codex',
      executable: '/opt/current-codex',
      update: { provider: 'none' },
    };
    bot.cliPathOverride = '/opt/current-codex';
    const s = makeActivePersistentSession('om_rt_unfrozen_runtime');
    s.cliPathOverride = '/opt/legacy-codex';
    sessionStore.updateSession(s);
    registerDs(s);

    expect(await closeCliMismatchedSessionsForBot('app_test'))
      .toMatchObject({ closed: 0 });
    expect(closeSession).not.toHaveBeenCalledWith(s.sessionId);
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('active');
  });

  it('defers a CLI-mismatch close during relay and resweeps after the gate settles', async () => {
    const s = makeActivePersistentSession('om_rt_transfer');
    s.cliId = 'codex';
    sessionStore.updateSession(s);
    const ds = registerDs(s);
    transferState.active.add(ds);

    expect(await closeCliMismatchedSessionsForBot('app_test'))
      .toMatchObject({ closed: 0 });
    expect(closeSession).not.toHaveBeenCalledWith(s.sessionId);
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('active');

    const callbacks = [...(transferState.callbacks.get(ds) ?? [])];
    expect(callbacks).toHaveLength(1);
    transferState.active.delete(ds);
    for (const callback of callbacks) callback();

    await vi.waitFor(() => {
      expect(closeSession).toHaveBeenCalledWith(s.sessionId);
      expect(sessionStore.getSession(s.sessionId)!.status).toBe('closed');
    });
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

    expect(await closeCliMismatchedSessionsForBot('app_test'))
      .toMatchObject({ closed: 0 });
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

    expect(await closeCliMismatchedSessionsForBot('app_test'))
      .toMatchObject({ closed: 1 });
    expect(closeSession).toHaveBeenCalledWith(s.sessionId);
    expect(TmuxBackend.killSession).not.toHaveBeenCalled();
  });

  it('isolates a failed ZMX teardown during a runtime sweep and continues', async () => {
    const blocked = makeActivePersistentSession('om_rt_zmx_blocked', 'zmx');
    blocked.cliId = 'codex';
    sessionStore.updateSession(blocked);
    registerDs(blocked);
    const closable = makeActivePersistentSession('om_rt_zmx_closable', 'zmx');
    closable.cliId = 'codex';
    sessionStore.updateSession(closable);
    registerDs(closable);
    vi.mocked(ZmxBackend.killManagedSession)
      .mockImplementationOnce(() => { throw new Error('ownership probe unavailable'); })
      .mockImplementationOnce(() => undefined);

    await expect(closeCliMismatchedSessionsForBot('app_test'))
      .resolves.toMatchObject({ closed: 1 });

    expect(sessionStore.getSession(blocked.sessionId)?.status).toBe('active');
    expect(wp.registry!.get(sessionKey('om_rt_zmx_blocked', 'app_test'))?.session.sessionId).toBe(blocked.sessionId);
    expect(sessionStore.getSession(closable.sessionId)?.status).toBe('closed');
    expect(wp.registry!.get(sessionKey('om_rt_zmx_closable', 'app_test'))).toBeUndefined();
    expect(closeSession).toHaveBeenCalledWith(closable.sessionId);
    expect(closeSession).not.toHaveBeenCalledWith(blocked.sessionId);
  });

  it('returns 0 when the registry is not initialized', async () => {
    wp.registry = null;
    expect(await closeCliMismatchedSessionsForBot('app_test'))
      .toMatchObject({ closed: 0 });
  });

});
