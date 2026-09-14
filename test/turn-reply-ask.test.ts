import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import type { DaemonSession } from '../src/core/types.js';
import type { CreateAskInput, PendingAsk } from '../src/core/ask-types.js';
import { _allAskIds, _resetForTest, getAskSnapshot, registerAsk, setCanTalkChecker, setCardDispatcher,
  setAskPersistStore, restorePersistedAsks, submitAskFromDesktop } from '../src/core/ask-broker.js';
import { createAskPersistStore } from '../src/core/ask-persist-store.js';
import { createLarkAskCardDispatcher, handleAskCardAction } from '../src/im/lark/ask-card.js';
import { publishReplyCardAsk, replyCardAskTarget } from '../src/core/turn-reply-ask.js';
import { updateTurnReplyCard, settleTurnReplyCards, replyCardModeFor } from '../src/core/turn-reply-card.js';
import { TurnReplyCardStore, type TurnReplyCardTransport } from '../src/services/turn-reply-card.js';
import { buildTurnReplyCard, publicReplyCardActivity, publicReplyCardTools } from '../src/im/lark/turn-reply-card.js';
import { buildCanonicalFinalReplyCard } from '../src/im/lark/md-card.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../src/im/lark/turn-reply-card-size.js';
import { replyMessage, sendMessage, updateMessage } from '../src/im/lark/client.js';

vi.mock('../src/config.js', () => ({ config: { session: { dataDir: '' } } }));
vi.mock('../src/im/lark/ask-grant-request.js', () => ({ requestGrantForAskClicker: vi.fn(async () => 'unavailable') }));
vi.mock('../src/im/lark/card-handler.js', () => ({ resolveCardOperatorUnionId: vi.fn() }));
vi.mock('../src/core/cost-calculator.js', () => ({ getSessionUsageSnapshot: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: { larkAppId: 'app', cliId: 'claude-code' } }), normalizeUsageDisplay: () => 'off' }));
vi.mock('../src/im/lark/client.js', () => ({ replyMessage: vi.fn(), sendMessage: vi.fn(), updateMessage: vi.fn(), MessageWithdrawnError: class extends Error {} }));

const key = { larkAppId: 'app', sessionId: 'sid', turnId: 'om_turn' };
const input: CreateAskInput = {
  larkAppId: 'app', sessionId: 'sid', chatId: 'oc_chat', rootMessageId: 'om_root', timeoutMs: 60_000,
  replyCardTarget: { turnId: 'om_turn' },
  questions: [{ prompt: '继续执行吗？', multiSelect: false, options: [{ key: 'yes', label: '继续' }, { key: 'no', label: '停止' }] }],
};
const presentation = { showProcess: true, showToolResults: true, canStop: true };
let dir: string;
let store: TurnReplyCardStore;
let io: TurnReplyCardTransport;
let body: string;
const publishing = new Set<Promise<unknown>>();
function bindDispatcher() {
  const dispatcher = createLarkAskCardDispatcher();
  const track = <T>(work: Promise<T>): Promise<T> => {
    const pending = work.finally(() => publishing.delete(pending));
    publishing.add(pending);
    return pending;
  };
  setCardDispatcher({ send: ask => track(dispatcher.send(ask)),
    onSettle: (ask, result) => track(Promise.resolve(dispatcher.onSettle!(ask, result))) });
}

beforeEach(async () => {
  _resetForTest(); vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'botmux-inline-ask-'));
  config.session.dataDir = dir;
  store = new TurnReplyCardStore(dir);
  vi.mocked(replyMessage).mockImplementation(async (_app, _root, content) => { body = content; return 'om_reply'; });
  vi.mocked(sendMessage).mockImplementation(async (_app, _chat, content) => { body = content; return 'om_standalone'; });
  vi.mocked(updateMessage).mockImplementation(async (_app, id, content) => { expect(id).toBe('om_reply'); body = content; });
  io = {
    beforeEffect: () => {}, isWithdrawn: () => false, render: record => buildTurnReplyCard(record, presentation),
    send: (content, uuid) => replyMessage('app', 'om_root', content, 'interactive', true, uuid),
    patch: (id, content) => updateMessage('app', id, content),
  };
  await store.prepare(key, { mode: 'unified', chatId: 'oc_chat', rootId: 'om_root' });
  await store.update(key, { kind: 'start' }, io);
  setCanTalkChecker((_app, _chat, by) => by === 'ou_owner');
  bindDispatcher();
});
afterEach(async () => { _resetForTest(); await Promise.allSettled([...publishing]); rmSync(dir, { recursive: true, force: true }); });

async function ask(overrides: Partial<CreateAskInput> = {}) {
  const answer = registerAsk({ ...input, ...overrides });
  const id = _allAskIds().at(-1)!;
  await vi.waitFor(() => expect(getAskSnapshot(id)?.cardMessageId).toBe('om_reply'));
  return { snapshot: getAskSnapshot(id)!, answer };
}
function optionButton(key: string) {
  return JSON.parse(body).body.elements.flatMap((element: any) =>
    element.columns?.flatMap((column: any) => column.elements) ?? [],
  ).find((element: any) => element.behaviors?.some((behavior: any) =>
    ['ask_select', 'ask_toggle'].includes(behavior.value?.action) && behavior.value?.key === key));
}
async function click(snapshot: PendingAsk, value: Record<string, string>, by = 'ou_owner', messageId = 'om_reply') {
  const response = await handleAskCardAction({
    operator: { open_id: by }, context: { open_message_id: messageId },
    action: { value: { ask_id: snapshot.askId, nonce: snapshot.nonce, ...value } },
  }, { larkAppId: 'app', requestGrant: () => 'unavailable' });
  // The event dispatcher executes this only after the platform callback ACK.
  const effect = (response as { afterAck?: () => Promise<void> })?.afterAck;
  if (effect) await effect();
  expect(response).not.toHaveProperty('card');
  expect(response).not.toHaveProperty('body');
  return response;
}

describe('Ask inside the running reply card', () => {
  it('keeps pending options usable when the execution history exceeds the card size limit', async () => {
    await store.update(key, { kind: 'tools', tools: [{ id: 't', name: 'Read', subject: 'large.txt', result: '工具输出'.repeat(10_000) }] }, io);
    const { snapshot, answer } = await ask();
    await store.update(key, { kind: 'progress', text: '等待你的选择' }, io);
    expect(body).toContain('已截断');
    expect(body).toContain('继续执行吗');
    expect(turnReplyCardRequestBytes(body, input.chatId)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    const choice = optionButton('yes').behaviors[0].value;
    expect(choice).toMatchObject({ ask_id: snapshot.askId, nonce: snapshot.nonce, action: 'ask_select', key: 'yes' });
    await click(snapshot, choice);
    expect(await answer).toMatchObject({ kind: 'answered', answers: [['yes']] });
    expect(body).not.toContain('ask_select');
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps a question, concurrent progress and final in one message', async () => {
    const { snapshot, answer } = await ask();
    expect(body).toContain('等待你确认');
    expect(body).toContain('ask_select');
    expect(optionButton('yes')).not.toHaveProperty('icon');
    await store.update(key, { kind: 'progress', text: '已经检查完成' }, io);
    expect(body).toContain('继续执行吗');
    await click(snapshot, { action: 'ask_select', key: 'yes' });
    expect(await answer).toMatchObject({ kind: 'answered', answers: [['yes']] });
    await store.update(key, { kind: 'final', text: '执行完成', card: buildCanonicalFinalReplyCard({ markdown: '执行完成' }), source: 'explicit' }, io);
    await store.update(key, { kind: 'terminal', phase: 'completed' }, io);
    expect(body).toContain('执行完成');
    expect(body).toContain('继续执行吗');
    expect(body).toContain('✓ 继续');
    expect(body).not.toContain('ask_select');
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('preserves multi-select state across worker/CLI patches and empty-submit confirmation', async () => {
    const { snapshot, answer } = await ask({ questions: [{ ...input.questions[0], multiSelect: true }] });
    expect(optionButton('yes')).toMatchObject({ text: { content: '继续' }, type: 'default',
      icon: { tag: 'standard_icon', token: 'rectangle_outlined' } });
    await click(snapshot, { action: 'ask_toggle', key: 'yes', question_index: '0' });
    await store.update(key, { kind: 'phase', phase: 'working' }, io);
    expect(optionButton('yes')).toMatchObject({ text: { content: '继续' }, type: 'primary',
      icon: { tag: 'standard_icon', token: 'check_outlined' } });
    expect(body).toContain('等待你确认');
    await click(snapshot, { action: 'ask_toggle', key: 'yes', question_index: '0' });
    expect(optionButton('yes')).toMatchObject({ type: 'default', icon: { token: 'rectangle_outlined' } });
    await click(snapshot, { action: 'ask_submit' });
    await store.update(key, { kind: 'progress', text: '等待你的选择' }, io);
    expect(body).toContain('confirm_empty');
    expect(getAskSnapshot(snapshot.askId)?.settled).toBe(false);
    await click(snapshot, { action: 'ask_submit', confirm_empty: 'true' });
    expect(await answer).toMatchObject({ kind: 'answered', answers: [[]] });
    expect(body).not.toContain('ask_toggle');
  });

  it('keeps concurrent questions and reveals the next one after an answer', async () => {
    const first = await ask();
    const second = await ask({ questions: [{ ...input.questions[0], prompt: '选择第二步' }] });
    expect(body).toContain('还有 1 个待回答请求');
    expect(body).not.toContain('选择第二步');
    await click(first.snapshot, { action: 'ask_select', key: 'yes' });
    expect(await first.answer).toMatchObject({ kind: 'answered' });
    expect(body).toContain('选择第二步');
    expect(body).toContain('继续执行吗');
    await click(second.snapshot, { action: 'ask_select', key: 'no' });
    await second.answer;
    expect(replyMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects unauthorized, wrong-message and wrong-app callbacks without changing the answer', async () => {
    const { snapshot } = await ask();
    expect(await click(snapshot, { action: 'ask_select', key: 'yes' }, 'ou_stranger')).toHaveProperty('toast');
    expect(await click(snapshot, { action: 'ask_select', key: 'yes' }, 'ou_owner', 'om_other')).toHaveProperty('toast');
    await handleAskCardAction({ operator: { open_id: 'ou_owner' }, context: { open_message_id: 'om_reply' },
      action: { value: { action: 'ask_select', key: 'yes', ask_id: snapshot.askId, nonce: snapshot.nonce } },
    }, { larkAppId: 'other_app' });
    expect(getAskSnapshot(snapshot.askId)?.settled).toBe(false);
  });

  it('records timeouts without allowing a late initial snapshot to restore buttons', async () => {
    const { snapshot, answer } = await ask({ timeoutMs: 150 });
    expect(await answer).toMatchObject({ kind: 'timedOut' });
    await publishReplyCardAsk(snapshot);
    expect(body).toContain('超时未答');
    expect(body).not.toContain('ask_select');
    expect(body).not.toContain('等待你确认');
  });

  it('keeps callback refreshes from overwriting a newer final answer', async () => {
    const { snapshot, answer } = await ask();
    const response = await handleAskCardAction({ operator: { open_id: 'ou_owner' }, context: { open_message_id: 'om_reply' },
      action: { value: { action: 'ask_select', key: 'yes', ask_id: snapshot.askId, nonce: snapshot.nonce } },
    }, { larkAppId: 'app' }) as { afterAck: () => Promise<void> };
    await answer;
    await store.update(key, { kind: 'final', text: 'latest final', card: buildCanonicalFinalReplyCard({ markdown: 'latest final' }), source: 'explicit' }, io);
    await store.update(key, { kind: 'terminal', phase: 'completed' }, io);
    await Promise.allSettled([...publishing]);
    vi.mocked(updateMessage).mockClear();
    await response.afterAck();
    expect(updateMessage).toHaveBeenCalledTimes(1); // ACK may have restored the old UI even if JSON is unchanged.
    expect(body).toContain('latest final');
    expect(body).not.toContain('ask_select');
  });

  it('retains an accepted answer whose publication arrives after the runtime terminal', async () => {
    const { snapshot, answer } = await ask();
    const dispatcher = createLarkAskCardDispatcher();
    const gate = Promise.withResolvers<void>();
    let settled: Promise<void> | undefined;
    setCardDispatcher({ send: dispatcher.send, onSettle: (ask, result) => {
      settled = gate.promise.then(() => dispatcher.onSettle!(ask, result));
      return settled;
    } });
    submitAskFromDesktop({ askId: snapshot.askId, selections: [['yes']] });
    await answer;
    await store.update(key, { kind: 'terminal', phase: 'completed' }, io);
    gate.resolve(); await settled;
    expect(body).toContain('✓ 继续');
    expect(body).not.toContain('已失效');
    expect(body).not.toContain('ask_select');
  });

  it('preserves the inline target and selected options across a resumable hook restart', async () => {
    const bind = () => setAskPersistStore(createAskPersistStore(join(dir, 'asks')));
    bind();
    const { snapshot } = await ask({ requestId: 'restart', originKind: 'hook', backendSurvivesRestart: true,
      questions: [{ ...input.questions[0], multiSelect: true }] });
    await click(snapshot, { action: 'ask_toggle', key: 'yes', question_index: '0' });
    _resetForTest(); bind(); setCanTalkChecker(() => true); bindDispatcher();
    restorePersistedAsks(Date.now(), 'app');
    expect(getAskSnapshot(snapshot.askId)).toMatchObject({ replyCardTarget: input.replyCardTarget, selections: [['yes']] });
    await click(getAskSnapshot(snapshot.askId)!, { action: 'ask_submit' });
    expect(body).not.toContain('ask_submit');
    expect(replyMessage).toHaveBeenCalledTimes(1);
  });

  it('updates the same card when a desktop answer settles the broker', async () => {
    const { snapshot, answer } = await ask();
    expect(submitAskFromDesktop({ askId: snapshot.askId, selections: [['no']] })).toBe('accepted');
    await answer;
    await vi.waitFor(() => expect(body).not.toContain('ask_select'));
    expect(body).toContain('✓ 停止');
  });

  it('invalidates only this turn’s inline asks when runtime execution ends', async () => {
    const { snapshot, answer } = await ask();
    const ds = { larkAppId: 'app', chatId: 'oc_chat', currentTurnId: 'om_turn',
      session: { sessionId: 'sid', rootMessageId: 'om_root', cliId: 'claude-code', status: 'active' } } as DaemonSession;
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'terminal', phase: 'cancelled' }, async () => 'om_reply');
    expect(await answer).toMatchObject({ kind: 'invalidated' });
    expect(getAskSnapshot(snapshot.askId)?.settled).toBe(true);
    expect(body).not.toContain('ask_select');
    expect(body).toContain('已停止');
  });

  it('keeps the persisted choice after a transient patch failure', async () => {
    const { snapshot } = await ask({ questions: [{ ...input.questions[0], multiSelect: true }] });
    vi.mocked(updateMessage).mockRejectedValueOnce(new Error('connection reset'));
    await click(snapshot, { action: 'ask_toggle', key: 'yes', question_index: '0' });
    expect(optionButton('yes')).toMatchObject({ type: 'primary', icon: { token: 'check_outlined' } });
    expect(replyMessage).toHaveBeenCalledTimes(1);
  });

  it('removes orphaned explicit Ask controls on disconnect recovery', async () => {
    await ask();
    await Promise.allSettled([...publishing]);
    _resetForTest();
    const ds = { larkAppId: 'app', chatId: 'oc_chat', currentTurnId: 'om_turn',
      session: { sessionId: 'sid', rootMessageId: 'om_root', cliId: 'claude-code', status: 'active' } } as DaemonSession;
    replyCardModeFor(ds, 'om_turn');
    await settleTurnReplyCards(ds);
    expect(body).not.toContain('ask_select');
    expect(body).toContain('已失效');
    expect(body).toContain('执行状态待确认');
  });

  it('admits only a matching running turn and retains independent presentation for oversized questions', () => {
    const ds = { larkAppId: 'app', chatId: 'oc_chat', replyCardRunningTurnId: 'om_turn',
      session: { sessionId: 'sid', rootMessageId: 'om_root' } } as DaemonSession;
    const origin = { originTurnId: 'om_turn' };
    expect(replyCardAskTarget(ds, input, origin)).toEqual(input.replyCardTarget);
    expect(replyCardAskTarget(ds, input, { originTurnId: 'om_other' })).toBeUndefined();
    expect(replyCardAskTarget(ds, { ...input, chatId: 'oc_other' }, origin)).toBeUndefined();
    expect(replyCardAskTarget(ds, input, { ...origin, originDispatchAttempt: 2 })).toBeUndefined();
    expect(replyCardAskTarget(ds, { ...input, questions: [{ ...input.questions[0], prompt: '文'.repeat(2000) }] }, origin)).toBeUndefined();
    const group = { ...ds, scope: 'chat' as const };
    expect(replyCardAskTarget(group, { ...input, rootMessageId: null }, origin)).toEqual(input.replyCardTarget);
    expect(replyCardAskTarget(group, { ...input, rootMessageId: 'oc_chat' }, origin)).toEqual(input.replyCardTarget);
    expect(replyCardAskTarget(group, { ...input, rootMessageId: 'om_other_thread' }, origin)).toBeUndefined();
  });

  it('keeps sandbox Ask standalone even when the daemon can read an old unified card', async () => {
    const ds = { larkAppId: 'app', chatId: 'oc_chat', replyCardRunningTurnId: 'om_turn',
      session: { sessionId: 'sid', rootMessageId: 'om_root', sandbox: true } } as DaemonSession;
    const replyCardTarget = replyCardAskTarget(ds, input, { originTurnId: 'om_turn' });
    expect(replyCardTarget).toBeUndefined();
    vi.mocked(replyMessage).mockClear();
    vi.mocked(updateMessage).mockClear();
    const { snapshot, answer } = await ask({ replyCardTarget });
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(store.read(key)?.asks).toBeUndefined();
    await click(snapshot, { action: 'ask_select', key: 'yes' });
    expect(await answer).toMatchObject({ kind: 'answered', answers: [['yes']] });
  });

  it('orders emitted reasoning, tools, progress and answers without duplicating cumulative snapshots', async () => {
    const entries = [
      { kind: 'thinking' as const, text: '先检查配置 <at id=ou_other></at>' },
      { kind: 'tool_call' as const, id: 'read', name: 'Read', args: '{}', subject: 'config.ts' },
    ];
    const event = { kind: 'tools' as const, tools: publicReplyCardTools(entries, true), activity: publicReplyCardActivity(entries) };
    await store.update(key, event, io);
    await store.update(key, { kind: 'progress', text: '已找到配置' }, io);
    const { snapshot, answer } = await ask();
    await click(snapshot, { action: 'ask_select', key: 'yes' }); await answer;
    await store.update(key, event, io);
    const activity = store.read(key)!.activity!;
    expect(activity.map(item => item.kind)).toEqual(['thinking', 'tool', 'progress', 'ask']);
    expect(body).toContain('先检查配置');
    expect(body).not.toContain('<at');
    const hidden = buildTurnReplyCard(store.read(key)!, { ...presentation, showProcess: false });
    expect(hidden).not.toContain('先检查配置');
    expect(hidden).not.toContain('config.ts');
    expect(hidden).toContain('已找到配置');
    expect(hidden).toContain('继续执行吗');
  });
});
