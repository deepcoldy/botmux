/**
 * Unit tests for killWorker's orphaned-backing-session teardown (worker-pool.ts).
 *
 * Bug: clicking 「关闭会话」/close does not kill the CLI running in tmux when the
 * session has no live worker. A persistent backend (tmux/herdr/zellij/zmx) keeps its
 * backing session + CLI alive across a worker exit BY DESIGN (idle-suspend and
 * lazy-restore resume into it later). killWorker used to early-return when
 * `ds.worker` was null, so the 'close' IPC — and the worker-side destroySession()
 * that tears the backing session down — never ran. The orphaned CLI kept living
 * in tmux and still replied after /close.
 *
 * Fix: when there is no live worker, killWorker destroys the backing session
 * directly via the deterministic session name. Adopt sessions are skipped (the
 * user's own pane must never be killed).
 *
 * Run:  pnpm vitest run test/kill-worker-orphaned-backend.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

const {
  tmuxKill,
  herdrKill,
  herdrKillAgent,
  herdrKillAgents,
  herdrList,
  zellijKill,
  zmxKill,
  zmxList,
  getBotMock,
} = vi.hoisted(() => ({
  tmuxKill: vi.fn(),
  herdrKill: vi.fn(),
  herdrKillAgent: vi.fn(),
  herdrKillAgents: vi.fn(),
  herdrList: vi.fn(() => [] as string[]),
  zellijKill: vi.fn(),
  zmxKill: vi.fn(),
  zmxList: vi.fn(() => [] as string[]),
  getBotMock: vi.fn(() => ({ resolvedAllowedUsers: [], config: {} })),
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: tmuxKill },
}));
vi.mock('../src/adapters/backend/herdr-backend.js', () => ({
  HerdrBackend: {
    sessionName: (id: string) => `bmx-${id.slice(0, 8)}`,
    killSession: herdrKill,
    killAgent: herdrKillAgent,
    killAgents: herdrKillAgents,
    listBotmuxSessions: herdrList,
  },
}));
vi.mock('../src/adapters/backend/zellij-backend.js', () => ({
  ZellijBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: zellijKill },
}));
vi.mock('../src/adapters/backend/zmx-backend.js', () => ({
  ZmxBackend: {
    sessionName: (id: string) => `bmx-${id.slice(0, 8)}`,
    killManagedSession: zmxKill,
    listBotmuxSessions: zmxList,
  },
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: getBotMock,
  getBotBrand: vi.fn(() => 'feishu'),
  getAllBots: vi.fn(() => []),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  sendEphemeralCard: vi.fn(),
  sendUserMessage: vi.fn(),
  addReaction: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
  deleteFrozenCards: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { config } from '../src/config.js';
import { managedHerdrAgentName } from '../src/adapters/backend/session-backend-selector.js';
import {
  killStalePids,
  killWorker,
  setActiveSessionSafe,
  teardownAuthoritativePersistentBackingBeforeClose,
} from '../src/core/worker-pool.js';
import { activeSessionKey } from '../src/core/types.js';
import * as sessionStore from '../src/services/session-store.js';

const SID = 'abcd1234-0000-0000-0000-000000000000';
const EXPECTED_NAME = 'bmx-abcd1234';

// All stream-card fields left unset on both ds and ds.session so
// persistStreamCardState() early-returns (no disk write) during clearUsageLimitState.
const ds = (over: Partial<DaemonSession> = {}, initOver: any = {}): DaemonSession => ({
  larkAppId: 'app',
  chatId: 'oc_here',
  chatType: 'group',
  scope: 'chat',
  worker: null,
  session: { sessionId: SID },
  initConfig: { backendType: 'tmux', ...initOver },
  ...over,
} as unknown as DaemonSession);

beforeEach(() => {
  vi.clearAllMocks();
  herdrList.mockReturnValue([]);
  zmxList.mockReturnValue([]);
  getBotMock.mockReturnValue({ resolvedAllowedUsers: [], config: {} } as any);
});

describe('killStalePids — ZMX CLI-change cleanup', () => {
  it('keeps the complete owning session identity and does not issue a second name-only kill', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-zmx-cli-change-'));
    const previousDataDirEnv = process.env.SESSION_DATA_DIR;
    const previousBackendType = config.daemon.backendType;
    const previousCliId = config.daemon.cliId;

    try {
      config.session.dataDir = dataDir;
      config.daemon.backendType = 'zmx';
      config.daemon.cliId = 'codex';
      sessionStore.init('zmx-cli-change-test');
      writeFileSync(join(dataDir, 'last-cli-id-zmx'), 'claude-code', 'utf8');
      zmxList.mockReturnValue([EXPECTED_NAME]);

      expect(() => killStalePids([{
        sessionId: SID,
        backendType: 'zmx',
      } as any])).not.toThrow();

      expect(zmxKill).toHaveBeenCalledTimes(1);
      expect(zmxKill).toHaveBeenCalledWith(EXPECTED_NAME, SID);
    } finally {
      sessionStore.init();
      config.daemon.cliId = previousCliId;
      config.daemon.backendType = previousBackendType;
      if (previousDataDirEnv === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDirEnv;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('continues global CLI-change cleanup after one managed ZMX kill refuses ownership', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-zmx-global-cli-change-'));
    const previousDataDirEnv = process.env.SESSION_DATA_DIR;
    const previousBackendType = config.daemon.backendType;
    const previousCliId = config.daemon.cliId;
    const firstId = '33333333-0000-0000-0000-000000000000';
    const secondId = '44444444-0000-0000-0000-000000000000';

    try {
      config.session.dataDir = dataDir;
      config.daemon.backendType = 'zmx';
      config.daemon.cliId = 'codex';
      sessionStore.init('zmx-global-cli-change-test');
      writeFileSync(join(dataDir, 'last-cli-id-zmx'), 'claude-code', 'utf8');
      zmxList.mockReturnValue(['bmx-33333333', 'bmx-44444444']);
      zmxKill
        .mockImplementationOnce(() => { throw new Error('ownership probe unavailable'); })
        .mockImplementationOnce(() => undefined);

      expect(() => killStalePids([
        { sessionId: firstId, status: 'active', backendType: 'zmx' } as any,
        { sessionId: secondId, status: 'active', backendType: 'zmx' } as any,
      ])).not.toThrow();

      expect(zmxKill).toHaveBeenNthCalledWith(1, 'bmx-33333333', firstId);
      expect(zmxKill).toHaveBeenNthCalledWith(2, 'bmx-44444444', secondId);
    } finally {
      sessionStore.init();
      config.daemon.cliId = previousCliId;
      config.daemon.backendType = previousBackendType;
      if (previousDataDirEnv === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDirEnv;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('continues cleaning other CLI-mismatch rows when one exact ZMX kill fails closed', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-zmx-mismatch-cleanup-'));
    const previousDataDirEnv = process.env.SESSION_DATA_DIR;
    const previousBackendType = config.daemon.backendType;
    const previousCliId = config.daemon.cliId;
    const firstId = '11111111-0000-0000-0000-000000000000';
    const secondId = '22222222-0000-0000-0000-000000000000';

    try {
      config.session.dataDir = dataDir;
      config.daemon.backendType = 'zmx';
      config.daemon.cliId = 'codex';
      sessionStore.init('zmx-mismatch-cleanup-test');
      writeFileSync(join(dataDir, 'last-cli-id-zmx'), 'codex', 'utf8');
      getBotMock.mockReturnValue({
        resolvedAllowedUsers: [],
        config: { cliId: 'codex' },
      } as any);
      zmxKill
        .mockImplementationOnce(() => { throw new Error('ownership probe unavailable'); })
        .mockImplementationOnce(() => undefined);

      expect(() => killStalePids([
        {
          sessionId: firstId,
          status: 'active',
          larkAppId: 'app-one',
          cliId: 'claude-code',
          backendType: 'zmx',
          persistentBackendTarget: {
            backendType: 'zmx',
            sessionName: 'bmx-11111111',
          },
        } as any,
        {
          sessionId: secondId,
          status: 'active',
          larkAppId: 'app-two',
          cliId: 'claude-code',
          backendType: 'zmx',
          persistentBackendTarget: {
            backendType: 'zmx',
            sessionName: 'bmx-22222222',
          },
        } as any,
      ])).not.toThrow();

      expect(zmxKill).toHaveBeenNthCalledWith(1, 'bmx-11111111', firstId);
      expect(zmxKill).toHaveBeenNthCalledWith(2, 'bmx-22222222', secondId);
    } finally {
      sessionStore.init();
      config.daemon.cliId = previousCliId;
      config.daemon.backendType = previousBackendType;
      if (previousDataDirEnv === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDirEnv;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('killStalePids — shared Herdr orphan cleanup', () => {
  it('kills only strongly-bound persisted agents that are no longer active', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-herdr-orphan-cleanup-'));
    const previousDataDirEnv = process.env.SESSION_DATA_DIR;
    const previousBackendType = config.daemon.backendType;
    const previousCliId = config.daemon.cliId;
    const orphanSessionId = '11111111-0000-0000-0000-000000000001';
    const activeSessionId = '22222222-0000-0000-0000-000000000002';
    const runtimeSessionId = '33333333-0000-0000-0000-000000000003';
    const orphanTarget = {
      backendType: 'herdr',
      sessionName: 'botmux',
      agentName: managedHerdrAgentName(orphanSessionId, dataDir),
    } as const;
    const activeTarget = {
      backendType: 'herdr',
      sessionName: 'botmux',
      agentName: managedHerdrAgentName(activeSessionId, dataDir),
    } as const;
    const runtimeTarget = {
      backendType: 'herdr',
      sessionName: 'botmux',
      agentName: managedHerdrAgentName(runtimeSessionId, dataDir),
    } as const;

    try {
      config.session.dataDir = dataDir;
      config.daemon.backendType = 'herdr';
      config.daemon.cliId = 'codex';
      sessionStore.init('herdr-orphan-cleanup-test');
      writeFileSync(join(dataDir, 'last-cli-id-herdr'), 'codex', 'utf8');

      const active = {
        sessionId: activeSessionId,
        status: 'active',
        backendType: 'herdr',
        persistentBackendTarget: activeTarget,
      } as any;
      for (const session of [
        active,
        {
          sessionId: orphanSessionId,
          status: 'closed',
          backendType: 'herdr',
          persistentBackendTarget: orphanTarget,
        },
        {
          sessionId: '44444444-0000-0000-0000-000000000004',
          status: 'closed',
          backendType: 'herdr',
          // A syntactically strong name belonging to another complete id is
          // not startup-cleanup authority for this row.
          persistentBackendTarget: orphanTarget,
        },
        {
          sessionId: '55555555-0000-0000-0000-000000000005',
          status: 'closed',
          backendType: 'herdr',
          persistentBackendTarget: {
            backendType: 'herdr',
            sessionName: 'botmux',
            agentName: 'botmux-deadbeef',
          },
        },
        {
          sessionId: runtimeSessionId,
          status: 'active',
          backendType: 'herdr',
          persistentBackendTarget: runtimeTarget,
        },
        {
          sessionId: 'adopted0-0000-0000-0000-000000000000',
          status: 'closed',
          backendType: 'herdr',
          adoptedFrom: { source: 'herdr', cwd: '/tmp' },
          persistentBackendTarget: {
            backendType: 'herdr',
            sessionName: 'botmux',
            agentName: 'user-sibling',
          },
        },
        {
          sessionId: 'hostonly-0000-0000-0000-000000000000',
          status: 'closed',
          backendType: 'herdr',
          persistentBackendTarget: {
            backendType: 'herdr',
            sessionName: 'botmux',
          },
        },
      ]) {
        sessionStore.updateSession(session);
      }

      killStalePids(
        [active],
        new Map([[
          'runtime',
          {
            session: {
              sessionId: runtimeSessionId,
              status: 'active',
              backendType: 'herdr',
              persistentBackendTarget: runtimeTarget,
            },
          } as any,
        ]]),
      );

      expect(herdrKillAgents).toHaveBeenCalledTimes(1);
      expect(herdrKillAgents).toHaveBeenCalledWith(
        'botmux',
        new Set([managedHerdrAgentName(orphanSessionId, dataDir)]),
      );
      expect(herdrKill).not.toHaveBeenCalledWith('botmux');
    } finally {
      sessionStore.init();
      config.daemon.cliId = previousCliId;
      config.daemon.backendType = previousBackendType;
      if (previousDataDirEnv === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDirEnv;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('preserves a current runtime agent while a global CLI change removes stale exact agents', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-herdr-cli-change-'));
    const previousDataDirEnv = process.env.SESSION_DATA_DIR;
    const previousBackendType = config.daemon.backendType;
    const previousCliId = config.daemon.cliId;
    const target = (sessionId: string) => ({
      backendType: 'herdr' as const,
      sessionName: 'botmux',
      agentName: managedHerdrAgentName(sessionId, dataDir),
    });
    const staleActiveId = '66666666-0000-0000-0000-000000000006';
    const runtimeId = '77777777-0000-0000-0000-000000000007';
    const staleClosedId = '88888888-0000-0000-0000-000000000008';

    try {
      config.session.dataDir = dataDir;
      config.daemon.backendType = 'herdr';
      config.daemon.cliId = 'codex';
      sessionStore.init('herdr-cli-change-test');
      writeFileSync(join(dataDir, 'last-cli-id-herdr'), 'claude-code', 'utf8');

      const staleActive = {
        sessionId: staleActiveId,
        status: 'active',
        backendType: 'herdr',
        persistentBackendTarget: target(staleActiveId),
      } as any;
      const runtime = {
        sessionId: runtimeId,
        status: 'active',
        backendType: 'herdr',
        persistentBackendTarget: target(runtimeId),
      } as any;
      for (const session of [
        staleActive,
        runtime,
        {
          sessionId: staleClosedId,
          status: 'closed',
          backendType: 'herdr',
          persistentBackendTarget: target(staleClosedId),
        },
      ]) {
        sessionStore.updateSession(session);
      }

      killStalePids(
        [staleActive],
        new Map([['runtime', { session: runtime } as any]]),
      );

      expect(herdrKillAgents).toHaveBeenCalledTimes(1);
      expect(herdrKillAgents).toHaveBeenCalledWith(
        'botmux',
        new Set([
          managedHerdrAgentName(staleActiveId, dataDir),
          managedHerdrAgentName(staleClosedId, dataDir),
        ]),
      );
    } finally {
      sessionStore.init();
      config.daemon.cliId = previousCliId;
      config.daemon.backendType = previousBackendType;
      if (previousDataDirEnv === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDirEnv;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('killWorker — orphaned backing session teardown (no live worker)', () => {
  it('destroys the tmux backing session by deterministic name', () => {
    const d = ds({ managedTurnOrigin: { capability: 'cap-stale', turnId: 'om-stale' } }, { backendType: 'tmux' });
    killWorker(d);
    expect(tmuxKill).toHaveBeenCalledWith(EXPECTED_NAME);
    expect(herdrKill).not.toHaveBeenCalled();
    expect(zellijKill).not.toHaveBeenCalled();
    expect(d.managedTurnOrigin).toBeUndefined();
  });

  it('destroys the herdr backing session', () => {
    killWorker(ds({}, { backendType: 'herdr' }));
    expect(herdrKill).toHaveBeenCalledWith(EXPECTED_NAME);
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it('closes only the recorded managed agent for a shared Herdr session', () => {
    const d = ds({
      session: {
        sessionId: SID,
        backendType: 'herdr',
        persistentBackendTarget: {
          backendType: 'herdr',
          sessionName: 'work',
          agentName: 'botmux-abcd1234',
        },
      } as any,
    }, { backendType: 'herdr' });

    killWorker(d);

    expect(herdrKillAgent).toHaveBeenCalledWith('work', 'botmux-abcd1234');
    expect(herdrKill).not.toHaveBeenCalled();
  });

  it('destroys the zellij backing session', () => {
    killWorker(ds({}, { backendType: 'zellij' }));
    expect(zellijKill).toHaveBeenCalledWith(EXPECTED_NAME);
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it('destroys the zmx backing session', () => {
    killWorker(ds({}, { backendType: 'zmx' }));
    expect(zmxKill).toHaveBeenCalledWith(EXPECTED_NAME, SID);
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it('does nothing for a non-persistent pty backend', () => {
    killWorker(ds({}, { backendType: 'pty' }));
    expect(tmuxKill).not.toHaveBeenCalled();
    expect(herdrKill).not.toHaveBeenCalled();
    expect(zellijKill).not.toHaveBeenCalled();
    expect(zmxKill).not.toHaveBeenCalled();
  });

  it('SKIPS adopt sessions (initConfig.adoptMode) — never kills the user\'s own pane', () => {
    killWorker(ds({}, { backendType: 'tmux', adoptMode: true }));
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it('SKIPS adopt sessions (ds.adoptedFrom set)', () => {
    killWorker(ds({ adoptedFrom: { source: 'tmux' } as any }, { backendType: 'tmux' }));
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it('falls back to the bot config backendType when initConfig is absent (lazy-restored session)', () => {
    getBotMock.mockReturnValue({ resolvedAllowedUsers: [], config: { backendType: 'herdr' } } as any);
    killWorker(ds({ initConfig: undefined } as any, {}));
    expect(herdrKill).toHaveBeenCalledWith(EXPECTED_NAME);
    expect(tmuxKill).not.toHaveBeenCalled();
  });
});

describe('killWorker — with a live worker (unchanged path)', () => {
  it('sends the close IPC to the worker and does NOT kill the backing session directly', () => {
    const send = vi.fn();
    const d = ds({
      worker: { killed: false, send, once: vi.fn() } as any,
      managedTurnOrigin: { capability: 'cap-live', turnId: 'om-live' },
    }, { backendType: 'tmux' });
    killWorker(d);
    expect(send).toHaveBeenCalledWith({ type: 'close' });
    // The live worker's own destroySession() handles teardown — daemon must not
    // double-kill here.
    expect(tmuxKill).not.toHaveBeenCalled();
    expect(d.worker).toBeNull();
    expect(d.managedTurnOrigin).toBeUndefined();
  });

  it('REFUSES unprepared live retirement for EVERY remote backend, not just riff (P0-2)', () => {
    // The guard used to hard-code `closeFrozenType === 'riff'`, so a live Mojo
    // worker hit the generic path: a request-less `close` IPC whose worker-side
    // legacy handler answered with destroySession() — `mojo session cancel` —
    // silently and irreversibly cancelling the remote session on /cd cold
    // restarts, crash-loops, collision losers and restore/upgrade.
    for (const remote of ['riff', 'mojo'] as const) {
      vi.clearAllMocks();
      const send = vi.fn();
      const d = ds({ worker: { killed: false, send, once: vi.fn() } as any }, { backendType: remote });
      killWorker(d);
      expect(send, remote).not.toHaveBeenCalled();
      // Worker and remote-task lineage are preserved for a prepared close.
      expect(d.worker, remote).not.toBeNull();
    }
  });

  it('collision loser: a REMOTE loser is retired process-only, never orphaned (gate 2)', async () => {
    // The loser's registry entry is deleted right after retirement, so a
    // killWorker refusal (correct for lineage) left a live credential-carrying
    // mojo worker unreachable — the P0-new orphan shape through another door.
    // A remote loser must die as a PROCESS: SIGTERM + backstop, no close IPC
    // (which the worker refuses request-less), no remote cancel.
    const send = vi.fn();
    const kill = vi.fn();
    const loser = ds({
      worker: { killed: false, send, kill, once: vi.fn() } as any,
      session: {
        sessionId: 'aaaa1111-0000-0000-0000-000000000000',
        status: 'active',
        backendType: 'mojo',
        riffParentTaskId: 'mojo-task-loser',
      } as any,
    }, { backendType: 'mojo' });
    const winner = ds({
      session: { sessionId: 'bbbb2222-0000-0000-0000-000000000000', status: 'active' } as any,
    }, { backendType: 'mojo' });
    const key = activeSessionKey(winner);
    const map = new Map([[activeSessionKey(loser), loser]]);

    const result = await setActiveSessionSafe(map, key, winner);

    expect(result.accepted).toBe(true);
    // Process-only retirement: SIGTERM sent, no close IPC, worker slot cleared.
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(send).not.toHaveBeenCalled();
    expect(loser.worker).toBeNull();
    expect(map.get(key)).toBe(winner);
    // The remote lineage was NOT cancelled — it stays for manual cleanup.
    expect(loser.session.riffParentTaskId).toBe('mojo-task-loser');
  });

  it('still retires a live remote worker when the prepare/commit requestId is carried (P0-2)', () => {
    for (const remote of ['riff', 'mojo'] as const) {
      vi.clearAllMocks();
      const send = vi.fn();
      const d = ds({
        worker: { killed: false, send, once: vi.fn() } as any,
        remoteCloseState: { requestId: 'req-1' } as any,
      }, { backendType: remote });
      killWorker(d, { remoteCloseCommitRequestId: 'req-1' });
      expect(send, remote).toHaveBeenCalledWith({ type: 'close_commit', requestId: 'req-1' });
      expect(d.worker, remote).toBeNull();
      expect(d.remoteCloseState, remote).toBeUndefined();
    }
  });

});

describe('teardownAuthoritativePersistentBackingBeforeClose', () => {
  it('synchronously proves ZMX teardown before callers mutate close state', () => {
    const d = ds({ worker: { killed: false } as any }, { backendType: 'zmx' });

    teardownAuthoritativePersistentBackingBeforeClose(d);

    expect(zmxKill).toHaveBeenCalledWith(EXPECTED_NAME, SID);
    expect(d.worker).not.toBeNull();
    expect(d.session.status).toBeUndefined();
  });

  it('propagates ZMX ownership refusal without mutating the session', () => {
    const refusal = new Error('ownership probe unavailable');
    zmxKill.mockImplementationOnce(() => { throw refusal; });
    const d = ds({ worker: { killed: false } as any }, { backendType: 'zmx' });

    expect(() => teardownAuthoritativePersistentBackingBeforeClose(d)).toThrow(refusal);
    expect(d.worker).not.toBeNull();
    expect(d.session.status).toBeUndefined();
  });

  it('is a no-op for non-ZMX, queued, and adopted sessions', () => {
    teardownAuthoritativePersistentBackingBeforeClose(ds({}, { backendType: 'tmux' }));
    teardownAuthoritativePersistentBackingBeforeClose(ds({ session: { sessionId: SID, queued: true } as any }, { backendType: 'zmx' }));
    teardownAuthoritativePersistentBackingBeforeClose(ds({ adoptedFrom: { source: 'tmux' } as any }, { backendType: 'zmx' }));

    expect(zmxKill).not.toHaveBeenCalled();
    expect(tmuxKill).not.toHaveBeenCalled();
  });
});
