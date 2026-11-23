/**
 * Clicking a reply card's「下一步」button, through the real card handler and
 * the real card-click binder: the token is minted the way the reply card
 * mints it (same per-bot secret file), the clicker's permissions decide, the
 * text becomes the clicker's turn, and the bot acknowledges in the thread.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dataDir: '',
  botConfig: { larkAppId: 'cli_app_next', cliId: 'claude-code', replyCardNextStep: true } as Record<string, unknown>,
  canOperate: vi.fn(() => true),
  sendWorkerInput: vi.fn(() => true),
  sendMessage: vi.fn(async () => 'om_chat_notice'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { get dataDir() { return mocks.dataDir; } },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ botName: 'Bot', botOpenId: 'ou_bot', config: mocks.botConfig, resolvedAllowedUsers: [] }),
  getAllBots: () => [],
  getOwnerOpenId: () => 'ou_owner',
  getBotClient: () => undefined,
}));
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: mocks.sendMessage,
  sendUserMessage: vi.fn(),
  updateMessage: vi.fn(),
  replyMessage: vi.fn(),
  getMessageDetail: vi.fn(),
  isHumanOpenId: vi.fn(() => true),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
}));
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(() => true),
  sendWorkerInput: mocks.sendWorkerInput,
  getCurrentCliVersion: () => 'test',
  withActiveSessionKeyLock: async (_map: unknown, _key: unknown, action: () => unknown) => action(),
}));
vi.mock('../src/core/session-manager.js', () => ({
  buildNewTopicCliInput: () => ({ content: 'opening' }),
  buildFollowUpCliInput: (content: string) => ({ content }),
  rememberLastCliInput: () => undefined,
}));
vi.mock('../src/services/session-store.js', () => ({
  createSession: vi.fn(),
  updateSession: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock('../src/core/session-activity.js', () => ({
  markSessionActivity: vi.fn(),
  publishAttentionPatch: vi.fn(),
  publishClosedSessionPatch: vi.fn(),
  announcePendingRepoSession: vi.fn(),
}));
vi.mock('../src/im/lark/identity-cache.js', () => ({
  getIdentity: () => undefined,
  resolveSender: async (_app: string, openId: string) => ({ openId, name: 'Clicker', type: 'user' as const }),
}));
vi.mock('../src/im/lark/event-dispatcher.js', () => ({
  isKnownPeerBot: () => false,
  evaluateTalk: () => ({ allowed: true, reason: 'allowedUser' }),
  canOperate: (..._args: unknown[]) => mocks.canOperate(),
  canTalk: () => true,
  grantCommandRestriction: () => ({ blocked: false }),
  isTrustedSameOwnerSiblingBot: () => false,
}));
vi.mock('../src/services/team-bots-store.js', () => ({ isTeamBot: () => false }));
vi.mock('../src/services/platform-team-store.js', () => ({ isPlatformTeamBot: () => false }));

import { handleCardAction } from '../src/im/lark/card-handler.js';
import { createCardClickTurnBinder } from '../src/services/card-click-turn-bind.js';
import { issueSessionCardClickTurn } from '../src/services/card-click-turn-secret.js';
import { buildNextStepElement } from '../src/im/lark/next-step-card.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';

const APP = 'cli_app_next';
const ROOT = 'om_thread_root';
const SID = 'sess-next-step-click';
const CLICKER = 'ou_clicker';

mocks.dataDir = mkdtempSync(join(tmpdir(), 'botmux-next-step-click-'));
afterAll(() => rmSync(mocks.dataDir, { recursive: true, force: true }));

function liveSession(): DaemonSession {
  return {
    session: { sessionId: SID, chatId: 'oc_chat', rootMessageId: ROOT, scope: 'thread', larkAppId: APP, ownerOpenId: 'ou_owner', workingDir: '/tmp' },
    worker: { killed: false },
    larkAppId: APP,
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    hasHistory: true,
    workingDir: '/tmp',
  } as unknown as DaemonSession;
}

function setup() {
  const ds = liveSession();
  const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);
  const beginNewTurn = vi.fn();
  const binder = createCardClickTurnBinder({
    activeSessions,
    dataDir: () => mocks.dataDir,
    noteTurnReceived: async () => {},
    beginNewTurn,
    trustedCallerForInboundTurn: async (_app, openId) => ({ senderType: 'user', requestUserOpenId: openId } as any),
  });
  const sessionReply = vi.fn(async () => 'om_ack');
  const deps = { activeSessions, sessionReply, lastRepoScan: new Map(), cardClickTurn: binder.accept } as any;
  return { ds, deps, sessionReply, beginNewTurn };
}

/** The callback Lark delivers for the row's button, as the reply card built it. */
function nextStepClick(text: string, operator = CLICKER): any {
  const token = issueSessionCardClickTurn({ dataDir: mocks.dataDir, larkAppId: APP, sessionId: SID, prompt: text })!;
  const element = buildNextStepElement({ text, ...token }) as any;
  return {
    operator: { open_id: operator },
    action: { value: element.columns[1].elements[0].behaviors[0].value },
    context: { open_message_id: 'om_reply_card' },
  };
}

async function click(data: any, deps: any): Promise<any> {
  const result = await handleCardAction(data, deps, APP);
  await result?.afterAck?.(false);
  return result;
}

beforeEach(() => {
  mocks.botConfig.replyCardNextStep = true;
  mocks.canOperate.mockReset().mockReturnValue(true);
  mocks.sendWorkerInput.mockReset().mockReturnValue(true);
  mocks.sendMessage.mockClear();
});

describe('next-step button click', () => {
  it('sends the suggestion as the clicker and acknowledges in the thread', async () => {
    const { ds, deps, sessionReply, beginNewTurn } = setup();
    const result = await click(nextStepClick('CI 绿了就合'), deps);
    expect(result.toast.type).toBe('info');
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(1);
    const [, input, turnId, opts] = mocks.sendWorkerInput.mock.calls[0] as unknown as [unknown, { content: string }, string, any];
    expect(input.content).toBe('CI 绿了就合');
    expect(opts.trustedCaller.requestUserOpenId).toBe(CLICKER);
    expect(ds.session.lastCallerOpenId).toBe(CLICKER);
    expect(beginNewTurn).toHaveBeenCalledWith(ds, 'CI 绿了就合', turnId);
    expect(sessionReply).toHaveBeenCalledWith(ROOT, '收到并开始执行：CI 绿了就合', 'text', APP);
    // The generic click-turn notice to the chat is not sent as well.
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a clicker without operate permission and starts nothing', async () => {
    mocks.canOperate.mockReturnValue(false);
    const { deps, sessionReply } = setup();
    const result = await click(nextStepClick('CI 绿了就合', 'ou_viewer'), deps);
    expect(result.toast).toEqual({ type: 'error', content: '需要可操作权限才能使用这个按钮' });
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('works once per button', async () => {
    const { deps } = setup();
    const data = nextStepClick('查 CI 结果');
    await click(data, deps);
    const again = await click(data, deps);
    expect(again.toast).toEqual({ type: 'error', content: '这个按钮已经用过了' });
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(1);
  });

  it('stops working when the bot switch is turned off', async () => {
    const { deps } = setup();
    const data = nextStepClick('确认发版');
    mocks.botConfig.replyCardNextStep = false;
    const result = await click(data, deps);
    expect(result.toast).toEqual({ type: 'error', content: '这个按钮当前不可用' });
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
  });

  it('reports a delivery failure in the thread and keeps the button usable', async () => {
    mocks.sendWorkerInput.mockReturnValue(false);
    const { deps, sessionReply } = setup();
    const data = nextStepClick('可以合了');
    await click(data, deps);
    expect(sessionReply).toHaveBeenCalledWith(ROOT, '没能把这一轮送进会话', 'text', APP);
    // Nothing reached the session, so the same button works once the session can take it.
    mocks.sendWorkerInput.mockReturnValue(true);
    const retry = await click(data, deps);
    expect(retry.toast.type).toBe('info');
    expect(sessionReply).toHaveBeenLastCalledWith(ROOT, '收到并开始执行：可以合了', 'text', APP);
    expect(await click(data, deps)).toMatchObject({ toast: { type: 'error', content: '这个按钮已经用过了' } });
  });

  it('never turns an <at> in the echoed text into a mention', async () => {
    const { deps, sessionReply } = setup();
    await click(nextStepClick('通知 <at user_id="all">所有人</at>'), deps);
    const notice = (sessionReply.mock.calls[0] as unknown[])[1] as string;
    expect(notice).not.toMatch(/<at\b/i);
    expect(notice).toContain('所有人');
  });
});
