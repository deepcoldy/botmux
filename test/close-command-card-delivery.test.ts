import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as botRegistry from '../src/bot-registry.js';
import * as larkClient from '../src/im/lark/client.js';
import * as sessionStore from '../src/services/session-store.js';
import * as docSubsStore from '../src/services/doc-subs-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import { handleCommand } from '../src/core/command-handler.js';
import { activeSessionKey, sessionAnchorId, type DaemonSession } from '../src/core/types.js';

let dataDir: string;
let previousDataDir: string;
beforeEach(() => {
  previousDataDir = config.session.dataDir;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-command-'));
  config.session.dataDir = dataDir;
  sessionStore.init('app-close-command');
  vi.spyOn(docSubsStore, 'listDocSubscriptionsForSession').mockReturnValue([]);
});
afterEach(() => {
  workerPool.setActiveSessionsRegistry(new Map());
  config.session.dataDir = previousDataDir;
  sessionStore.init('app-close-command');
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

function fixture(options: {
  scope?: 'chat' | 'thread'; streamCardId?: string; privateCard?: boolean;
  disableStreamingCard?: boolean; noCardChats?: string[]; apiOnly?: boolean;
} = {}) {
  const bot = {
    config: { cliId: 'claude-code', larkAppId: 'app-close-command', ...options },
    resolvedAllowedUsers: ['ou_owner'], resolvedBlockedUsers: [],
  };
  vi.spyOn(botRegistry, 'getBot').mockReturnValue(bot as any);
  const session = sessionStore.createSession('oc_close', 'om_root', 'close command', 'group');
  session.larkAppId = 'app-close-command';
  session.cliId = 'claude-code';
  session.scope = options.scope ?? 'thread';
  sessionStore.updateSession(session);
  const ds = {
    session, worker: null, larkAppId: session.larkAppId, chatId: session.chatId,
    chatType: 'group', scope: session.scope, hasHistory: true,
    streamCardId: options.streamCardId,
  } as DaemonSession;
  const activeSessions = new Map([[activeSessionKey(ds), ds]]);
  workerPool.setActiveSessionsRegistry(activeSessions);
  const patch = vi.spyOn(larkClient, 'updateMessage').mockResolvedValue(undefined as any);
  const ephemeral = vi.spyOn(larkClient, 'sendEphemeralCard').mockResolvedValue('om_private');
  const reply = vi.fn(async () => 'om_reply');
  const close = () => handleCommand('/close', sessionAnchorId(ds), {
    messageId: 'om_command', rootId: sessionAnchorId(ds), senderId: 'ou_operator',
    senderType: 'user', msgType: 'text', content: '/close', createTime: String(Date.now()),
  }, {
    activeSessions, sessionReply: reply, getActiveCount: () => activeSessions.size,
    lastRepoScan: new Map(),
  }, ds.larkAppId);
  return { ds, patch, ephemeral, reply, close };
}

describe('/close card delivery through the real session lifecycle', () => {
  it('patches a thread live card once without posting a second closed card', async () => {
    const f = fixture({ streamCardId: 'om_live' });
    await f.close();
    expect(f.patch).toHaveBeenCalledExactlyOnceWith('app-close-command', 'om_live', expect.stringContaining('会话已关闭'), { beforeWrite: expect.any(Function) });
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.ephemeral).not.toHaveBeenCalled();
    expect(sessionStore.getSession(f.ds.session.sessionId)?.status).toBe('closed');
  });

  it.each([
    { name: 'missing live card' },
    { name: 'in-flight card POST', streamCardId: workerPool.CARD_POSTING_SENTINEL },
    { name: 'disabled streaming cards', streamCardId: 'om_old', disableStreamingCard: true },
    { name: 'no-card chat', streamCardId: 'om_old', noCardChats: ['oc_close'] },
    { name: 'API-only transport', streamCardId: 'om_synthetic', apiOnly: true },
  ])('keeps the reply fallback for $name', async options => {
    const f = fixture(options);
    await f.close();
    expect(f.patch).not.toHaveBeenCalled();
    expect(f.reply).toHaveBeenCalledExactlyOnceWith('om_root', expect.stringContaining('会话已关闭'), 'interactive', 'app-close-command', 'om_command');
    expect(f.ephemeral).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps private close cards owner-only (delivery fails: %s)', async fails => {
    const f = fixture({ streamCardId: 'om_live', privateCard: true });
    if (fails) f.ephemeral.mockRejectedValue(new Error('ephemeral unavailable'));
    await f.close();
    expect(f.ephemeral).toHaveBeenCalledExactlyOnceWith('app-close-command', 'oc_close', 'ou_owner', expect.stringContaining('会话已关闭'));
    expect(f.patch).not.toHaveBeenCalled();
    expect(f.reply).not.toHaveBeenCalled();
  });

  it('keeps the chat-scope operator confirmation alongside the live-card patch', async () => {
    const f = fixture({ streamCardId: 'om_live', scope: 'chat' });
    await f.close();
    expect(f.patch).toHaveBeenCalledTimes(1);
    expect(f.ephemeral).toHaveBeenCalledExactlyOnceWith('app-close-command', 'oc_close', 'ou_operator', expect.stringContaining('会话已关闭'));
    expect(f.reply).not.toHaveBeenCalled();
  });

  it('does not post a duplicate while the closing patch waits behind an in-flight update', async () => {
    const f = fixture({ streamCardId: 'om_live' });
    let release!: () => void;
    f.patch.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }) as any);
    try {
      workerPool.scheduleCardPatch(f.ds, 'working');
      await f.close();
      expect(f.patch).toHaveBeenCalledTimes(1);
      expect(f.reply).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(f.patch).toHaveBeenCalledTimes(2));
      expect(f.patch).toHaveBeenLastCalledWith('app-close-command', 'om_live', expect.stringContaining('会话已关闭'), { beforeWrite: expect.any(Function) });
      expect(workerPool.scheduleCardPatch(f.ds, 'late working')).toBe(false);
    } finally {
      release?.();
    }
  });
});
