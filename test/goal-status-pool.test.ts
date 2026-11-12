import { describe, expect, it } from 'vitest';
import { MessageWithdrawnError, MessageUpdateExpiredError } from '../src/im/lark/client.js';
import { TopicSendError } from '../src/cli/topic-send-guard.js';
import { GoalStatusCardController, goalStatusCardOrigin } from '../src/core/goal-status-card.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';
import { loadWorkerPoolMessageHandlers } from './helpers/worker-pool-message-harness.js';
import { isSilentScheduledTurn } from '../src/core/silent-schedule-turns.js';

function fixture(silent = false) {
  const acks: any[] = [], posts: any[] = [], patches: any[] = [];
  const worker = { send: (message: any) => acks.push(message) };
  const session: any = { status: 'active', workerGeneration: 1, rootMessageId: 'om_root', sessionId: 'session' };
  const ds: any = { worker, workerGeneration: 1, session, larkAppId: 'app', chatId: 'oc_chat', scope: 'thread' };
  if (silent) ds.silentScheduledTurns = new Map([['om_silent', Date.now()]]);
  let diskFails = false;
  let patchError: (() => unknown) | undefined;
  const scope: any = { ds, worker, workerGeneration: 1, handlerSession: session, handlerLarkAppId: 'app', handlerAnchor: 'om_root',
    sessionAnchorId: () => 'om_root', activeSessionsRegistry: undefined, getBot: () => ({ config: { apiOnly: false } }),
    privateReplyEnabled: () => false, isDocNativeSession: () => false, goalStatusCardOrigin, goalCardEntity: undefined,
    GoalStatusCardController, goalStatusCard: undefined, MessageWithdrawnError, MessageUpdateExpiredError, TopicSendError,
    sessionStore: { updateSession(s: any) { if (diskFails && s.nativeGoalStatusCard) throw new Error('disk write failed'); } },
    fallbackTurnId: (_ds: any, turn: any) => turn, larkTransportEnabled: () => true, isSilentMessageListenerSession: () => false,
    isSilentScheduledTurn, isMeetingDrivenTurn: () => false, isSubstituteTurn: () => false, isTriggerFinalSuppressed: () => false,
    getMessageChatId: async () => ds.chatId, resolveCardKitId: async () => 'card_id',
    updateCardJson: async (_app: any, _id: any, id: string, card: string, sequence: number, _uuid: any, opts: any) => {
      opts.beforeWrite(); if (patchError) throw patchError(); patches.push({ id, card: JSON.parse(card), sequence });
    }, localeForBot: () => 'zh', logger: { warn() {} }, t: 'test',
    scopedReply: async (card: string, _type: string, turn: string, opts: any) => {
      opts.beforeWrite(); posts.push({ turn, card: JSON.parse(card) }); return 'om_card';
    } };
  for (const name of ['ownsWorkerSession', 'goalCardOwns', 'ordinaryManagedSuppression', 'managedAuxUiSuppressed', 'goalCardCanDisplay']) {
    scope[name] = loadWorkerPoolClosure(name, scope);
  }
  const handler = loadWorkerPoolMessageHandlers(['goal_update'], scope);
  const goal = { goalId: 'g1', objective: 'goal', status: 'active', createdAt: 100, updatedAt: 101, timeUsedSeconds: 4 };
  const send = (changes = {}, turnId = 'om_user') => handler({ type: 'goal_update', signature: 'sig', turnId, goal: { ...goal, ...changes } });
  const settled = async () => { await scope.goalStatusCard?.settled(); };
  return { ds, session, scope, posts, patches, acks, send, settled, failDisk: (value: boolean) => { diskFails = value; },
    failPatch: (error?: () => unknown) => { patchError = error; }, close: () => scope.goalStatusCard?.dispose() };
}

describe('native goal worker-pool integration', () => {
  it('creates one card and completes it through the same message and sequenced update API', async () => {
    const f = fixture(); f.send(); await f.settled();
    f.send({ status: 'complete', updatedAt: 106, timeUsedSeconds: 9 }); await f.settled();
    expect(f.posts).toHaveLength(1);
    expect(f.patches.every(patch => patch.id === 'om_card')).toBe(true);
    expect(f.patches.at(-1).card.header.title.content).toContain('目标已完成');
    expect(f.patches.at(-1).card.body.elements[1].content).toBe('已运行：00:00:09');
    expect(f.acks).toHaveLength(2); f.close();
  });
  it('keeps a silent goal hidden through later normal metric updates and edits', async () => {
    const f = fixture(true); f.send({}, 'om_silent'); await f.settled();
    f.ds.silentScheduledTurns = undefined;
    f.send({ updatedAt: 102, timeUsedSeconds: 5 }); await f.settled();
    f.send({ objective: 'edited private goal', updatedAt: 103 }); await f.settled();
    expect(f.posts).toHaveLength(0); expect(f.session.nativeGoalStatusCard).toBeUndefined();
    expect(f.session.nativeGoalCardOrigin.hidden).toBe(true); f.close();
  });
  it('does not ACK a visible goal before its record is durably saved, and retries once storage recovers', async () => {
    const f = fixture(); f.failDisk(true);
    expect(() => f.send()).toThrow('disk write failed');
    expect(f.acks).toHaveLength(0); expect(f.session.nativeGoalStatusCard).toBeUndefined();
    f.failDisk(false); f.send(); await f.settled();
    expect(f.posts).toHaveLength(1); expect(f.acks).toHaveLength(1); f.close();
  });
  it('keeps the card when a topic lookup merely fails, and retires it only on a proven withdrawal', async () => {
    const f = fixture(); f.send(); await f.settled();
    f.failPatch(() => new TopicSendError('TOPIC_SEND_CHECK_FAILED', 'lookup failed'));
    f.send({ status: 'complete', updatedAt: 106, timeUsedSeconds: 9 }); await f.settled();
    expect(f.session.nativeGoalStatusCard).toMatchObject({ messageId: 'om_card', pendingPatch: true });
    expect(f.session.nativeGoalStatusCard.dead).toBeUndefined();
    f.failPatch(() => new TopicSendError('TOPIC_SEND_BLOCKED', 'withdrawn'));
    f.send({ status: 'complete', updatedAt: 107, timeUsedSeconds: 10 }); await f.settled();
    expect(f.session.nativeGoalStatusCard).toMatchObject({ messageId: 'om_card', dead: true, pendingPatch: false });
    f.failPatch(() => new MessageWithdrawnError('om_card'));
    f.send({ status: 'complete', updatedAt: 108, timeUsedSeconds: 11 }); await f.settled();
    expect(f.posts).toHaveLength(1); f.close();
  });
  it('recognises a withdrawn card on a replacement worker even though the chat lookup of a withdrawn message fails', async () => {
    const f = fixture(); f.send(); await f.settled();
    f.scope.goalCardEntity = undefined; // a new worker has not resolved the card yet
    f.scope.getMessageChatId = async () => null;
    f.scope.resolveCardKitId = async (_app: string, id: string) => { throw new MessageWithdrawnError(id); };
    f.send({ status: 'complete', updatedAt: 106, timeUsedSeconds: 9 }); await f.settled();
    expect(f.session.nativeGoalStatusCard).toMatchObject({ messageId: 'om_card', dead: true, pendingPatch: false });
    expect(f.posts).toHaveLength(1); f.close();
  });
});
