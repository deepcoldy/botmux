import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as sessionStore from '../src/services/session-store.js';
import {
  cleanupCommittedSessionSelfClose,
  commitSessionSelfClose,
  findActiveBySessionId,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';

const tempDirs: string[] = [];
const originalDataDir = config.session.dataDir;

function daemonSession(
  session: ReturnType<typeof sessionStore.createSession>,
  worker: DaemonSession['worker'],
): DaemonSession {
  return {
    session,
    worker,
    workerPort: worker ? 1234 : null,
    workerToken: worker ? 'worker-token' : null,
    larkAppId: 'app-a',
    chatId: session.chatId,
    chatType: 'group',
    scope: 'chat',
    spawnedAt: 1,
    lastMessageAt: 1,
    hasHistory: true,
    managedTurnOrigin: {
      capability: '90'.repeat(32),
      turnId: 'turn-a',
    },
  } as DaemonSession;
}

function setupSession(worker: DaemonSession['worker'] = null): {
  ds: DaemonSession;
  registry: Map<string, DaemonSession>;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-self-close-barrier-'));
  tempDirs.push(dataDir);
  config.session.dataDir = dataDir;
  sessionStore.init('app-a');
  const session = sessionStore.createSession('chat-a', 'root-a', 'old', 'group');
  session.larkAppId = 'app-a';
  session.scope = 'chat';
  session.cliId = 'codex';
  session.cliSessionId = 'provider-old';
  sessionStore.updateSession(session);
  const ds = daemonSession(session, worker);
  const registry = new Map([[sessionKey('chat-a', 'app-a'), ds]]);
  setActiveSessionsRegistry(registry);
  return { ds, registry };
}

afterEach(() => {
  setActiveSessionsRegistry(new Map());
  sessionStore.init();
  config.session.dataDir = originalDataDir;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('self-close logical barrier', () => {
  it('evicts and persists before worker cleanup, then cannot remove a fresh route', async () => {
    const send = vi.fn();
    const worker = {
      killed: false,
      connected: true,
      send,
      once: vi.fn(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    } as unknown as DaemonSession['worker'];
    const { ds, registry } = setupSession(worker);
    const oldSessionId = ds.session.sessionId;

    const committed = commitSessionSelfClose(ds);

    expect(findActiveBySessionId(oldSessionId)).toBeUndefined();
    expect(registry.has(sessionKey('chat-a', 'app-a'))).toBe(false);
    expect(sessionStore.getSession(oldSessionId)).toMatchObject({
      status: 'closed',
      cliSessionId: 'provider-old',
    });
    expect(send).not.toHaveBeenCalled();

    // Model the next chat message arriving after the barrier but before slow
    // cleanup. Its new logical/provider identity must not be touched by cleanup
    // of the old session.
    const fresh = sessionStore.createSession('chat-a', 'root-b', 'fresh', 'group');
    fresh.larkAppId = 'app-a';
    fresh.scope = 'chat';
    sessionStore.updateSession(fresh);
    const freshDs = daemonSession(fresh, null);
    registry.set(sessionKey('chat-a', 'app-a'), freshDs);

    await cleanupCommittedSessionSelfClose(committed);

    expect(send).toHaveBeenCalledWith({ type: 'close' });
    expect(registry.get(sessionKey('chat-a', 'app-a'))).toBe(freshDs);
    expect(fresh.sessionId).not.toBe(oldSessionId);
    expect(fresh.cliSessionId).toBeUndefined();
  });

  it('uses the same fresh-session barrier for thread scope and TRAE', async () => {
    const { ds, registry } = setupSession(null);
    ds.scope = 'thread';
    ds.session.scope = 'thread';
    ds.session.cliId = 'traex';
    ds.session.cliSessionId = 'trae-provider-old';
    sessionStore.updateSession(ds.session);
    registry.clear();
    registry.set(sessionKey('root-a', 'app-a'), ds);
    const oldSessionId = ds.session.sessionId;

    const committed = commitSessionSelfClose(ds);
    expect(registry.has(sessionKey('root-a', 'app-a'))).toBe(false);

    const fresh = sessionStore.createSession(
      'chat-a',
      'root-a',
      'fresh-thread',
      'group',
      'thread',
    );
    fresh.larkAppId = 'app-a';
    sessionStore.updateSession(fresh);
    const freshDs = daemonSession(fresh, null);
    freshDs.scope = 'thread';
    registry.set(sessionKey('root-a', 'app-a'), freshDs);

    await cleanupCommittedSessionSelfClose(committed);

    expect(registry.get(sessionKey('root-a', 'app-a'))).toBe(freshDs);
    expect(fresh.sessionId).not.toBe(oldSessionId);
    expect(fresh.cliSessionId).toBeUndefined();
    expect(sessionStore.getSession(oldSessionId)).toMatchObject({
      status: 'closed',
      cliId: 'traex',
      cliSessionId: 'trae-provider-old',
    });
  });

  it('keeps the route and capability retryable when persistence fails', () => {
    const { ds, registry } = setupSession(null);
    const origin = ds.managedTurnOrigin;
    vi.spyOn(sessionStore, 'closeSession').mockImplementation(() => {
      ds.session.status = 'closed';
      ds.session.closedAt = '2026-07-22T00:00:00.000Z';
      throw new Error('disk unavailable');
    });

    expect(() => commitSessionSelfClose(ds)).toThrow('disk unavailable');

    expect(registry.get(sessionKey('chat-a', 'app-a'))).toBe(ds);
    expect(ds.managedTurnOrigin).toBe(origin);
    expect(ds.session.status).toBe('active');
    expect(ds.session.closedAt).toBeUndefined();
  });

  it('does not kill a user-owned pane for an adopted session with no live bridge', async () => {
    const { ds } = setupSession(null);
    ds.adoptedFrom = {
      cliId: 'claude-code',
      sessionId: 'user-owned-provider-session',
    } as DaemonSession['adoptedFrom'];
    ds.session.backendType = 'tmux';
    sessionStore.updateSession(ds.session);
    const killSession = vi.spyOn(TmuxBackend, 'killSession');

    const committed = commitSessionSelfClose(ds);
    await cleanupCommittedSessionSelfClose(committed);

    expect(killSession).not.toHaveBeenCalled();
    expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('closed');
  });
});
