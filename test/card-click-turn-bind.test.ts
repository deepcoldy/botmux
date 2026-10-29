/**
 * The production binder must put the clicker on the turn, not the session owner.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  forkWorker: vi.fn(() => true),
  sendWorkerInput: vi.fn(() => true),
  getIdentity: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  isTeamBot: vi.fn(() => false),
  secretPaths: [] as string[],
}));

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: mocks.forkWorker,
  sendWorkerInput: mocks.sendWorkerInput,
  getCurrentCliVersion: () => 'test',
  withActiveSessionKeyLock: async (_map: unknown, _key: unknown, action: () => unknown) => action(),
}));
vi.mock('../src/core/session-manager.js', () => ({
  buildNewTopicCliInput: () => ({ content: 'opening' }),
  buildFollowUpCliInput: (_content: string, _id: string, opts?: { trustedCaller?: { requestUserOpenId?: string } }) =>
    ({ content: 'follow', trustedCaller: opts?.trustedCaller }),
  rememberLastCliInput: () => undefined,
}));
vi.mock('../src/services/session-store.js', () => ({
  createSession: mocks.createSession,
  updateSession: mocks.updateSession,
}));
vi.mock('../src/im/lark/identity-cache.js', () => ({
  getIdentity: mocks.getIdentity,
  resolveSender: async (_app: string, openId: string) => ({ openId, name: 'Clicker', type: 'user' as const }),
}));
vi.mock('../src/im/lark/event-dispatcher.js', () => ({
  isKnownPeerBot: () => false,
  evaluateTalk: () => ({ allowed: true, reason: 'allowedUser' }),
  canOperate: () => true,
  grantCommandRestriction: () => ({ blocked: false }),
  isTrustedSameOwnerSiblingBot: () => false,
}));
vi.mock('../src/services/team-bots-store.js', () => ({
  isTeamBot: (...args: unknown[]) => mocks.isTeamBot(...args),
}));
vi.mock('../src/services/platform-team-store.js', () => ({
  isPlatformTeamBot: () => false,
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ botName: 'Bot', botOpenId: 'ou_bot', config: { cliId: 'claude' } }),
}));
vi.mock('../src/dashboard/auth.js', () => ({
  loadOrCreateDashboardSecret: (path: string) => {
    mocks.secretPaths.push(path);
    return 'secret';
  },
}));
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: async () => 'om_card',
}));
vi.mock('../src/core/prompt-injection.js', () => ({
  sessionPromptInjection: () => undefined,
}));
vi.mock('../src/core/session-activity.js', () => ({
  markSessionActivity: () => undefined,
}));

import { issueCardClickTurn } from '../src/services/card-click-turn.js';
import { createCardClickTurnBinder } from '../src/services/card-click-turn-bind.js';
import type { DaemonSession } from '../src/core/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  mocks.forkWorker.mockReset();
  mocks.forkWorker.mockReturnValue(true);
  mocks.sendWorkerInput.mockReset();
  mocks.sendWorkerInput.mockReturnValue(true);
  mocks.getIdentity.mockReset();
  mocks.isTeamBot.mockReset();
  mocks.isTeamBot.mockReturnValue(false);
  mocks.createSession.mockReset();
  mocks.secretPaths.length = 0;
  delete process.env.BOTMUX_XPI_ENABLED;
});

function session(partial: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: {
      sessionId: 'sess-id-1',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 'existing',
      ownerOpenId: 'ou_owner',
      creatorOpenId: 'ou_creator',
      workingDir: '/tmp',
      status: 'active',
    },
    worker: { killed: false } as DaemonSession['worker'],
    workerPort: null,
    workerToken: null,
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'chat',
    spawnedAt: 1,
    cliVersion: 'test',
    lastMessageAt: 1,
    hasHistory: true,
    workingDir: '/tmp',
    ownerOpenId: 'ou_owner',
    ...partial,
  } as DaemonSession;
}

describe('card click turn binder', () => {
  it('publishes the clicker as the turn sender and leaves the owner off the caller', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'card-click-bind-'));
    dirs.push(dataDir);
    const ds = session();
    const activeSessions = new Map([['oc_chat::cli_app', ds]]);
    const callers: string[] = [];
    const binder = createCardClickTurnBinder({
      activeSessions,
      dataDir: () => dataDir,
      noteTurnReceived: async () => undefined,
      beginNewTurn: () => undefined,
      trustedCallerForInboundTurn: async (_app, openId) => {
        callers.push(openId);
        return { requestUserOpenId: openId, requestLarkAppId: 'cli_app', senderType: 'user' };
      },
    });
    const issued = issueCardClickTurn({
      secret: 'secret', larkAppId: 'cli_app', prompt: 'do the thing', chatId: 'oc_chat', now: Date.now(), nonce: 'nonce-nonce-nonce',
    });
    if (!issued.ok) throw new Error(issued.error);
    const accepted = await binder.accept({
      larkAppId: 'cli_app', operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const started = await accepted.run();
    expect(started.ok).toBe(true);
    expect(callers).toEqual(['ou_clicker']);
    expect(ds.session.ownerOpenId).toBe('ou_owner');
    expect(ds.session.lastCallerOpenId).toBe('ou_clicker');
    expect(ds.session.quoteTargetId).toBe(started.ok ? started.turnId : undefined);
    expect(mocks.secretPaths.some(path => path.includes('/card-click-turn/cli_app/secret'))).toBe(true);
    expect(ds.session.replyTargets?.[started.ok ? started.turnId : '']).toMatchObject({
      senderOpenId: 'ou_clicker',
      participants: [{ openId: 'ou_clicker', isBot: false }],
    });
    expect(ds.activeInteractiveTurn?.caller).toEqual({
      requestUserOpenId: 'ou_clicker', requestLarkAppId: 'cli_app', senderType: 'user',
    });
    expect(ds.activeInteractiveTurn?.controller).toBeUndefined();
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    const trusted = mocks.sendWorkerInput.mock.calls[0]?.[3]?.trustedCaller;
    expect(trusted).toMatchObject({ requestUserOpenId: 'ou_clicker', senderType: 'user' });
  });

  it('creates a chat session whose owner is the clicker', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'card-click-bind-'));
    dirs.push(dataDir);
    mocks.createSession.mockImplementation((chatId: string, root: string, title: string, chatType: 'group' | 'p2p', scope: 'chat') => ({
      sessionId: 'created-session-1',
      chatId,
      rootMessageId: root,
      title,
      chatType,
      scope,
      status: 'active',
    }));
    const activeSessions = new Map<string, DaemonSession>();
    const binder = createCardClickTurnBinder({
      activeSessions,
      dataDir: () => dataDir,
      noteTurnReceived: async () => undefined,
      beginNewTurn: () => undefined,
      trustedCallerForInboundTurn: async (_app, openId) => ({
        requestUserOpenId: openId, requestLarkAppId: 'cli_app', senderType: 'user' as const,
      }),
    });
    const issued = issueCardClickTurn({
      secret: 'secret', larkAppId: 'cli_app', prompt: 'do the thing', chatId: 'oc_new', workingDir: '/tmp', now: Date.now(), nonce: 'nonce-nonce-nonce3',
    });
    if (!issued.ok) throw new Error(issued.error);
    const accepted = await binder.accept({
      larkAppId: 'cli_app', operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const started = await accepted.run();
    expect(started.ok).toBe(true);
    const created = [...activeSessions.values()][0];
    expect(created?.ownerOpenId).toBe('ou_clicker');
    expect(created?.session.ownerOpenId).toBe('ou_clicker');
    expect(created?.session.creatorOpenId).toBe('ou_clicker');
    expect(created?.session.lastCallerOpenId).toBe('ou_clicker');
    expect(mocks.createSession).toHaveBeenCalledWith(
      'oc_new', 'oc_new', expect.any(String), 'group', 'chat', { source: 'ordinary-feishu' },
    );
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker.mock.calls[0]?.[2]).toMatchObject({
      trustedCaller: { requestUserOpenId: 'ou_clicker', senderType: 'user' },
    });
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
  });

  it('does not start a turn when the clicker is a cached app', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'card-click-bind-'));
    dirs.push(dataDir);
    mocks.getIdentity.mockReturnValue({ type: 'app', openId: 'ou_app' });
    const ds = session();
    const binder = createCardClickTurnBinder({
      activeSessions: new Map([['oc_chat::cli_app', ds]]),
      dataDir: () => dataDir,
      noteTurnReceived: async () => undefined,
      beginNewTurn: () => undefined,
      trustedCallerForInboundTurn: async () => {
        throw new Error('owner fallback');
      },
    });
    const issued = issueCardClickTurn({
      secret: 'secret', larkAppId: 'cli_app', prompt: 'do the thing', chatId: 'oc_chat', now: Date.now(), nonce: 'nonce-nonce-nonce2',
    });
    if (!issued.ok) throw new Error(issued.error);
    const accepted = await binder.accept({
      larkAppId: 'cli_app', operatorOpenId: 'ou_app', payload: issued.payload, sig: issued.sig,
    });
    expect(accepted).toEqual({ ok: false, reason: 'bot_or_app' });
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(ds.session.replyTargets).toBeUndefined();
  });

  it('treats a union-table team bot as a bot before any turn starts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'card-click-bind-'));
    dirs.push(dataDir);
    mocks.isTeamBot.mockReturnValue(true);
    const ds = session();
    const binder = createCardClickTurnBinder({
      activeSessions: new Map([['oc_chat::cli_app', ds]]),
      dataDir: () => dataDir,
      noteTurnReceived: async () => undefined,
      beginNewTurn: () => undefined,
      trustedCallerForInboundTurn: async () => { throw new Error('stamped a team bot'); },
    });
    const issued = issueCardClickTurn({
      secret: 'secret', larkAppId: 'cli_app', prompt: 'do the thing', chatId: 'oc_chat', now: Date.now(), nonce: 'nonce-nonce-nonce4',
    });
    if (!issued.ok) throw new Error(issued.error);
    const accepted = await binder.accept({
      larkAppId: 'cli_app', operatorOpenId: 'ou_team', operatorUnionId: 'on_team_bot', payload: issued.payload, sig: issued.sig,
    });
    expect(accepted).toEqual({ ok: false, reason: 'bot_or_app' });
    expect(mocks.isTeamBot).toHaveBeenCalled();
    expect(ds.activeInteractiveTurn).toBeUndefined();
  });

  it('does not deliver when the trusted caller is not the clicker', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'card-click-bind-'));
    dirs.push(dataDir);
    const ds = session();
    const binder = createCardClickTurnBinder({
      activeSessions: new Map([['oc_chat::cli_app', ds]]),
      dataDir: () => dataDir,
      noteTurnReceived: async () => undefined,
      beginNewTurn: () => undefined,
      trustedCallerForInboundTurn: async () => ({
        requestUserOpenId: 'ou_owner', requestLarkAppId: 'cli_app', senderType: 'user' as const,
      }),
    });
    const issued = issueCardClickTurn({
      secret: 'secret', larkAppId: 'cli_app', prompt: 'do the thing', chatId: 'oc_chat', now: Date.now(), nonce: 'nonce-nonce-nonce5',
    });
    if (!issued.ok) throw new Error(issued.error);
    const accepted = await binder.accept({
      larkAppId: 'cli_app', operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(await accepted.run()).toEqual({ ok: false, reason: 'delivery_failed' });
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(ds.activeInteractiveTurn).toBeUndefined();
    expect(ds.session.lastCallerOpenId).toBeUndefined();
  });

  it('rolls back a failed delivery so the session has no ghost turn', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'card-click-bind-'));
    dirs.push(dataDir);
    mocks.sendWorkerInput.mockReturnValue(false);
    const ds = session();
    ds.session.lastCallerOpenId = 'ou_previous';
    const binder = createCardClickTurnBinder({
      activeSessions: new Map([['oc_chat::cli_app', ds]]),
      dataDir: () => dataDir,
      noteTurnReceived: async () => undefined,
      beginNewTurn: () => undefined,
      trustedCallerForInboundTurn: async (_app, openId) => ({
        requestUserOpenId: openId, requestLarkAppId: 'cli_app', senderType: 'user' as const,
      }),
    });
    const issued = issueCardClickTurn({
      secret: 'secret', larkAppId: 'cli_app', prompt: 'do the thing', chatId: 'oc_chat', now: Date.now(), nonce: 'nonce-nonce-nonce6',
    });
    if (!issued.ok) throw new Error(issued.error);
    const accepted = await binder.accept({
      larkAppId: 'cli_app', operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(await accepted.run()).toEqual({ ok: false, reason: 'delivery_failed' });
    expect(ds.activeInteractiveTurn).toBeUndefined();
    expect(ds.session.lastCallerOpenId).toBe('ou_previous');
    expect(ds.session.quoteTargetSenderOpenId).toBeUndefined();
    expect(ds.session.replyTargets).toBeUndefined();
  });

  it('refuses a principal-lane session without consuming the button or writing a turn', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'card-click-bind-'));
    dirs.push(dataDir);
    const ds = session();
    ds.session.principalLane = { ownerOpenId: 'ou_owner' } as never;
    const binder = createCardClickTurnBinder({
      activeSessions: new Map([['oc_chat::cli_app', ds]]),
      dataDir: () => dataDir,
      noteTurnReceived: async () => undefined,
      beginNewTurn: () => undefined,
      trustedCallerForInboundTurn: async () => { throw new Error('lane click started'); },
    });
    const issued = issueCardClickTurn({
      secret: 'secret', larkAppId: 'cli_app', prompt: 'do the thing', chatId: 'oc_chat', now: Date.now(), nonce: 'nonce-nonce-nonce7',
    });
    if (!issued.ok) throw new Error(issued.error);
    const accepted = await binder.accept({
      larkAppId: 'cli_app', operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    });
    expect(accepted).toEqual({ ok: false, reason: 'principal_lane' });
    expect(ds.activeInteractiveTurn).toBeUndefined();
    const again = await binder.accept({
      larkAppId: 'cli_app', operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    });
    expect(again).toEqual({ ok: false, reason: 'principal_lane' });
  });

  it('refuses every click while cross-principal interruption is enabled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'card-click-bind-'));
    dirs.push(dataDir);
    process.env.BOTMUX_XPI_ENABLED = '1';
    const ds = session();
    const binder = createCardClickTurnBinder({
      activeSessions: new Map([['oc_chat::cli_app', ds]]),
      dataDir: () => dataDir,
      noteTurnReceived: async () => undefined,
      beginNewTurn: () => undefined,
      trustedCallerForInboundTurn: async () => { throw new Error('xpi click started'); },
    });
    const issued = issueCardClickTurn({
      secret: 'secret', larkAppId: 'cli_app', prompt: 'do the thing', chatId: 'oc_chat', now: Date.now(), nonce: 'nonce-nonce-nonce8',
    });
    if (!issued.ok) throw new Error(issued.error);
    const accepted = await binder.accept({
      larkAppId: 'cli_app', operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    });
    expect(accepted).toEqual({ ok: false, reason: 'cross_principal' });
    expect(ds.activeInteractiveTurn).toBeUndefined();
  });
});
