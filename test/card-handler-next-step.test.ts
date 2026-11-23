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
import { buildNextStepElement, NEXT_STEP_PROMPT_FIELD } from '../src/im/lark/next-step-card.js';
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

function setup(noteTurnReceived = async () => {}) {
  const ds = liveSession();
  ds.session.status = 'active';
  ds.currentTurnId = 'om_completed';
  ds.lastTurnTerminalTurnId = 'om_completed';
  ds.lastTurnTerminalStatus = 'completed';
  const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);
  const beginNewTurn = vi.fn();
  const binder = createCardClickTurnBinder({
    activeSessions,
    dataDir: () => mocks.dataDir,
    noteTurnReceived,
    beginNewTurn,
    trustedCallerForInboundTurn: async (_app, openId) => ({ senderType: 'user', requestUserOpenId: openId } as any),
  });
  const sessionReply = vi.fn(async () => 'om_ack');
  const deps = { activeSessions, sessionReply, lastRepoScan: new Map(), cardClickTurn: binder.accept } as any;
  return { ds, deps, sessionReply, beginNewTurn };
}

function simulateRestoredCompletedTurn(ds: DaemonSession, turnId = 'om_completed') {
  ds.currentTurnId = undefined;
  ds.lastTurnTerminalTurnId = undefined;
  ds.lastTurnTerminalDispatchAttempt = undefined;
  ds.lastTurnTerminalStatus = undefined;
  ds.session.lastTurn = { turnId, outcome: 'delivered', at: 1_000, startedAt: 900 };
  ds.lastMessageAt = 900;
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

function editableClick(prompt?: string, responseToTurnId = 'om_completed') {
  const text = '查 CI 结果';
  const token = issueSessionCardClickTurn({
    dataDir: mocks.dataDir, larkAppId: APP, sessionId: SID, prompt: text, responseToTurnId,
  })!;
  const row = buildNextStepElement({ text, ...token, editable: true }) as any;
  const panel = row.elements[0];
  const [field, submit] = panel.elements;
  return {
    row, panel, field, submit,
    data: {
      operator: { open_id: CLICKER }, context: { open_message_id: 'om_reply_card' },
      action: { value: submit.behaviors[0].value,
        ...(prompt === undefined ? {} : { form_value: { [NEXT_STEP_PROMPT_FIELD]: prompt } }) },
    },
  };
}

describe('editable Codex next step', () => {
  it('renders a collapsed draft and delivers only the confirmed edited text, once', async () => {
    const { deps, sessionReply } = setup();
    const { row, panel, field, submit, data } = editableClick('只查 Linux CI 的失败日志');
    expect(row.tag).toBe('form');
    expect(panel.expanded).toBe(false);
    expect(panel.behaviors).toBeUndefined();
    expect(field.default_value).toBe('查 CI 结果');
    expect(field.max_length).toBeLessThanOrEqual(1000);
    expect(submit.form_action_type).toBe('submit');
    const accepted = await handleCardAction(data, deps, APP);
    expect(accepted?.toast.type).toBe('info');
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    await accepted?.afterAck?.(false);
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(1);
    const [, input] = mocks.sendWorkerInput.mock.calls[0] as unknown as [unknown, { content: string }];
    expect(input.content).toBe('只查 Linux CI 的失败日志');
    expect(sessionReply).toHaveBeenCalledWith(ROOT, expect.stringContaining('只查 Linux CI 的失败日志'), 'text', APP);
    expect((await click(data, deps)).toast.type).toBe('error');
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(1);
  });

  it('issues and confirms a suggestion for a completed scheduled turn', async () => {
    const turnId = 'schedule:task_1:123e4567-e89b-42d3-a456-426614174000';
    const { ds, deps } = setup();
    ds.currentTurnId = turnId;
    ds.lastTurnTerminalTurnId = turnId;
    await click(editableClick('继续定时任务', turnId).data, deps);
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(1);
    const [, input] = mocks.sendWorkerInput.mock.calls[0] as unknown as [unknown, { content: string }];
    expect(input.content).toBe('继续定时任务');
  });

  it('accepts the latest persisted delivered turn after a daemon restart', async () => {
    const { ds, deps } = setup();
    simulateRestoredCompletedTurn(ds);
    await click(editableClick('重启后确认').data, deps);
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(1);
    const [, input] = mocks.sendWorkerInput.mock.calls[0] as unknown as [unknown, { content: string }];
    expect(input.content).toBe('重启后确认');
  });

  it('accepts a restored suggestion when this turn stamped activity after its start', async () => {
    const { ds, deps } = setup();
    simulateRestoredCompletedTurn(ds);
    ds.lastMessageAt = 950;
    ds.session.lastCliInputTurnId = 'om_completed';
    ds.session.currentReplyTarget = { turnId: 'om_completed' } as any;
    await click(editableClick('同轮稍后活动').data, deps);
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(1);
  });

  it('keeps a restored suggestion valid when the same completed terminal arrives late', async () => {
    const { ds, deps } = setup();
    simulateRestoredCompletedTurn(ds);
    ds.lastTurnTerminalTurnId = 'om_completed';
    ds.lastTurnTerminalDispatchAttempt = 1;
    ds.lastTurnTerminalStatus = 'completed';
    await click(editableClick('迟到终态后确认').data, deps);
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(1);
  });

  it('keeps a restored suggestion valid when the same completed terminal arrives during identity preparation', async () => {
    const preparing = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    const { ds, deps } = setup(() => {
      preparing.resolve();
      return prepared.promise;
    });
    simulateRestoredCompletedTurn(ds);
    const accepted = await handleCardAction(editableClick('等待期间终态到达').data, deps, APP);
    const dispatch = accepted?.afterAck?.(false);
    await preparing.promise;
    ds.lastTurnTerminalTurnId = 'om_completed';
    ds.lastTurnTerminalDispatchAttempt = 1;
    ds.lastTurnTerminalStatus = 'completed';
    prepared.resolve();
    await dispatch;
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(1);
  });

  it('rejects a restored suggestion when its latest terminal failed', async () => {
    const { ds, deps } = setup();
    simulateRestoredCompletedTurn(ds);
    ds.lastTurnTerminalTurnId = 'om_completed';
    ds.lastTurnTerminalStatus = 'failed';
    const result = await click(editableClick('失败轮建议').data, deps);
    expect(result.toast).toEqual({ type: 'error', content: '按钮已过期' });
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
  });

  it('rejects a restored suggestion when a newer input arrived while the old result was waiting', async () => {
    const { ds, deps } = setup();
    simulateRestoredCompletedTurn(ds);
    ds.session.lastTurn = { turnId: 'om_completed', outcome: 'delivered', startedAt: 900, at: 2_000 };
    ds.lastMessageAt = 1_000;
    ds.session.lastCliInputTurnId = 'om_new_turn';
    ds.session.currentReplyTarget = { turnId: 'om_new_turn' } as any;
    const result = await click(editableClick('旧建议').data, deps);
    expect(result.toast).toEqual({ type: 'error', content: '按钮已过期' });
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
  });

  it('rejects a restored suggestion when durable lineage names a newer turn without a timestamp advance', async () => {
    const { ds, deps } = setup();
    simulateRestoredCompletedTurn(ds);
    ds.session.lastCliInputTurnId = 'om_new_turn';
    ds.session.currentReplyTarget = { turnId: 'om_new_turn' } as any;
    const result = await click(editableClick('旧建议').data, deps);
    expect(result.toast).toEqual({ type: 'error', content: '按钮已过期' });
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
  });

  it('rolls back restored routing when identity preparation fails', async () => {
    const { ds, deps } = setup(async () => { throw new Error('identity unavailable'); });
    simulateRestoredCompletedTurn(ds);
    ds.session.quoteTargetId = 'om_previous';
    await click(editableClick('重启后确认').data, deps);
    expect(ds.session.quoteTargetId).toBe('om_previous');
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
  });

  it.each([undefined, '', ' '.repeat(10), 'x'.repeat(1001)])('rejects an invalid draft without consuming the button (%s)', async invalid => {
    const { deps } = setup();
    const { data } = editableClick(invalid);
    expect((await click(data, deps)).toast.type).toBe('error');
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    await click({ ...data, action: { ...data.action, form_value: { [NEXT_STEP_PROMPT_FIELD]: '查看 CI' } } }, deps);
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('preserves a newer route written while a restored click waits (%s)', async finish => {
    const preparing = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    const { ds, deps } = setup(() => {
      preparing.resolve();
      return prepared.promise;
    });
    simulateRestoredCompletedTurn(ds);
    const accepted = await handleCardAction(editableClick('恢复后的旧建议').data, deps, APP);
    const dispatch = accepted?.afterAck?.(false);
    await preparing.promise;
    // Another ingress has written its route but has not reached beginNewTurn yet.
    ds.lastMessageAt = 1_100;
    ds.session.quoteTargetId = 'om_new_turn';
    ds.session.quoteTargetSenderOpenId = 'ou_new_sender';
    ds.session.lastCallerOpenId = 'ou_new_sender';
    ds.session.replyTargets = { om_new_turn: { rootMessageId: ROOT } } as any;
    ds.session.turnReplyContexts = { om_new_turn: { requesterOpenId: 'ou_new_sender' } } as any;
    ds.currentReplyTarget = { turnId: 'om_new_turn' } as any;
    ds.session.currentReplyTarget = { turnId: 'om_new_turn' } as any;
    ds.activeInteractiveTurn = { turnId: 'om_new_turn' } as any;
    if (finish === 'resolve') prepared.resolve();
    else prepared.reject(new Error('identity failed'));
    await dispatch;
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(ds.session.quoteTargetId).toBe('om_new_turn');
    expect(ds.session.quoteTargetSenderOpenId).toBe('ou_new_sender');
    expect(ds.session.lastCallerOpenId).toBe('ou_new_sender');
    expect(ds.session.replyTargets).toHaveProperty('om_new_turn');
    expect(ds.session.turnReplyContexts).toHaveProperty('om_new_turn');
    expect(ds.currentReplyTarget).toMatchObject({ turnId: 'om_new_turn' });
    expect(ds.session.currentReplyTarget).toMatchObject({ turnId: 'om_new_turn' });
    expect(ds.activeInteractiveTurn).toMatchObject({ turnId: 'om_new_turn' });
  });

  it('does not dispatch if another message takes over before the callback is acknowledged', async () => {
    const { ds, deps, sessionReply } = setup();
    const accepted = await handleCardAction(editableClick('查看 CI').data, deps, APP);
    ds.currentTurnId = 'om_new_turn';
    await accepted?.afterAck?.(false);
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(sessionReply).toHaveBeenCalledWith(ROOT, '按钮已过期', 'text', APP);
  });

  it.each(['resolve', 'reject'] as const)('preserves a newer turn when identity preparation later %ss', async finish => {
    const preparing = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    const { ds, deps } = setup(() => {
      preparing.resolve();
      return prepared.promise;
    });
    const accepted = await handleCardAction(editableClick('查看 CI').data, deps, APP);
    const dispatch = accepted?.afterAck?.(false);
    await preparing.promise;
    ds.currentTurnId = 'om_new_turn';
    ds.session.quoteTargetId = 'om_new_turn';
    if (finish === 'resolve') prepared.resolve();
    else prepared.reject(new Error('temporary identity error'));
    await dispatch;
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(ds.session.quoteTargetId).toBe('om_new_turn');
  });

  it('cannot use form data to replace a prompt signed as a fixed button', async () => {
    const { deps } = setup();
    const data = nextStepClick('固定输入');
    data.action.form_value = { [NEXT_STEP_PROMPT_FIELD]: '尝试替换输入' };
    expect((await click(data, deps)).toast.type).toBe('error');
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
  });
});
