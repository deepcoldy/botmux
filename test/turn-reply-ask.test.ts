import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import type { DaemonSession } from '../src/core/types.js';
import type { CreateAskInput, PendingAsk } from '../src/core/ask-types.js';
import { NATIVE_STANDALONE_ASK_ORIGIN } from '../src/core/ask-types.js';
import { _allAskIds, _resetForTest, getAskSnapshot, registerAsk, setCanTalkChecker, setCardDispatcher,
  setAskPersistStore, restorePersistedAsks, submitAskFromDesktop, invalidateReplyCardAsks } from '../src/core/ask-broker.js';
import { createAskPersistStore } from '../src/core/ask-persist-store.js';
import { createLarkAskCardDispatcher, handleAskCardAction } from '../src/im/lark/ask-card.js';
import { publishReplyCardAsk, replyCardAskTarget } from '../src/core/turn-reply-ask.js';
import { updateTurnReplyCard, settleTurnReplyCards, replyCardModeFor } from '../src/core/turn-reply-card.js';
import { TurnReplyCardStore, type TurnReplyCardTransport } from '../src/services/turn-reply-card.js';
import { buildTurnReplyCard, publicReplyCardActivity, publicReplyCardTools } from '../src/im/lark/turn-reply-card.js';
import { buildTurnReplyAskElements } from '../src/im/lark/turn-reply-ask-elements.js';
import { buildCanonicalFinalReplyCard } from '../src/im/lark/md-card.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../src/im/lark/turn-reply-card-size.js';
import { replyMessage, sendMessage, updateMessage } from '../src/im/lark/client.js';
import { observePublishedGroupMessage } from '../src/services/group-context-runtime.js';
import { bindGroupContextDelivery, writePreparedGroupContext } from '../src/services/group-context-delivery-store.js';
import { groupContextEpoch } from '../src/services/group-context-prompt.js';

vi.mock('../src/config.js', () => ({ config: { session: { dataDir: '' } } }));
vi.mock('../src/im/lark/ask-grant-request.js', () => ({ requestGrantForAskClicker: vi.fn(async () => 'unavailable') }));
vi.mock('../src/im/lark/card-handler.js', () => ({ resolveCardOperatorUnionId: vi.fn() }));
vi.mock('../src/core/cost-calculator.js', () => ({ getSessionUsageSnapshot: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: { larkAppId: 'app', cliId: 'claude-code' } }), normalizeUsageDisplay: () => 'off' }));
vi.mock('../src/im/lark/client.js', () => ({ replyMessage: vi.fn(), sendMessage: vi.fn(), sendUserMessage: vi.fn(), updateMessage: vi.fn(), MessageWithdrawnError: class extends Error {} }));
vi.mock('../src/services/group-context-runtime.js', () => ({ observePublishedGroupMessage: vi.fn() }));

const key = { larkAppId: 'app', sessionId: 'sid', turnId: 'om_turn' };
const input: CreateAskInput = {
  larkAppId: 'app', sessionId: 'sid', chatId: 'oc_chat', rootMessageId: 'om_root', timeoutMs: 60_000,
  replyCardTarget: { turnId: 'om_turn' },
  questions: [{ prompt: '继续执行吗？', allowCustom: false, multiSelect: false, options: [{ key: 'yes', label: '继续' }, { key: 'no', label: '停止' }] }],
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
const cardNodes = (node: any = JSON.parse(body)): any[] => node && typeof node === 'object'
  ? [node, ...Object.values(node).flatMap(cardNodes)] : [];
function optionButton(key: string) {
  return cardNodes().find((element: any) => element.behaviors?.some((behavior: any) =>
    ['ask_select', 'ask_toggle'].includes(behavior.value?.action) && behavior.value?.key === key));
}
const checker = (name: string) => cardNodes().find((element: any) => element.tag === 'checker' && element.name === name);

function inlineAskWithQuestions(questions: PendingAsk['questions']): Parameters<typeof buildTurnReplyAskElements>[0] {
  return { ask: {
    askId: 'ask-inline', nonce: 'nonce-inline', larkAppId: 'app', chatId: 'oc_chat', rootMessageId: 'om_root',
    sessionId: 'sid', questions, createdAt: 1_000, deadlineAt: 61_000, settled: false,
  } };
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
/** Submits the one-shot checker form of the inline Ask with these field values. */
async function submitForm(snapshot: PendingAsk, value: Record<string, string>, formValue: Record<string, unknown>) {
  const response = await handleAskCardAction({
    operator: { open_id: 'ou_owner' }, context: { open_message_id: 'om_reply' },
    action: { value: { ask_id: snapshot.askId, nonce: snapshot.nonce, ...value }, form_value: formValue },
  }, { larkAppId: 'app', requestGrant: () => 'unavailable' });
  const effect = (response as { afterAck?: () => Promise<void> })?.afterAck;
  if (effect) await effect();
  expect(response).not.toHaveProperty('card');
  return response;
}

describe('Ask inside the running reply card', () => {
  it('captures native question authorship at admission and omits it for the answered refresh', async () => {
    const ds = { larkAppId: 'app', chatId: 'oc_chat', replyCardRunningTurnId: 'om_turn',
      session: { sessionId: 'sid', rootMessageId: 'om_root', cliId: 'claude-code', cliSessionId: 'native_ask', workerGeneration: 1 } } as DaemonSession;
    const binding = { appId: 'app', chatId: 'oc_chat', sessionId: 'sid', turnId: 'om_turn', workerGeneration: 1,
      epoch: groupContextEpoch('sid', 'native_ask', 'claude-code', 'om_turn') };
    writePreparedGroupContext({ ...binding, createdAt: Date.now(), body: '', includedSeqs: [], throughSeq: 0, incomplete: false }, dir);
    bindGroupContextDelivery(binding, dir);
    const target = replyCardAskTarget(ds, input, { originTurnId: 'om_turn' });
    expect(target?.groupContextAuthorOrigin).toEqual(binding);
    const { snapshot, answer } = await ask({ replyCardTarget: target });
    expect(vi.mocked(observePublishedGroupMessage).mock.calls.at(-1)?.[2]).toEqual(binding);
    vi.mocked(observePublishedGroupMessage).mockClear();
    submitAskFromDesktop({ askId: snapshot.askId, selections: [['yes']] });
    await answer;
    await Promise.allSettled([...publishing]);
    expect(vi.mocked(observePublishedGroupMessage).mock.calls.at(-1)?.[2]).toBeUndefined();
  });

  it('masks a content-audit-rejected question patch instead of failing the question', async () => {
    // The card already shows progress with an email; settling the question
    // re-renders the whole card and Lark rejects that text.
    const email = 'alice.liu@example.com';
    const { snapshot, answer } = await ask();
    await store.update(key, { kind: 'progress', text: `作者 <${email}>` }, io);
    const bodies: string[] = [];
    vi.mocked(updateMessage).mockImplementation(async (_app, _id, content) => {
      bodies.push(content);
      if (content.includes(email)) throw { isAxiosError: true, name: 'AxiosError', message: 'Request failed with status code 400',
        response: { status: 400, data: { code: 230028, msg: 'contain sensitive data: EMAIL_ADDRESS' } } };
      body = content;
    });
    await click(snapshot, { action: 'ask_select', key: 'yes' });
    expect(await answer).toMatchObject({ kind: 'answered', answers: [['yes']] });
    await vi.waitFor(() => expect(body).toContain('✓ 继续'));
    expect(bodies[0]).toContain(email);
    expect(body).not.toContain(email);
    expect(body).toContain('example.com');
    expect(body).toContain('部分内容已自动打码');
  });

  it('observes the acknowledged inline question patch for shared history', async () => {
    const { snapshot, answer } = await ask();
    expect(observePublishedGroupMessage).toHaveBeenCalledWith('app', expect.objectContaining({
      message_id: 'om_reply', chat_id: 'oc_chat', root_id: 'om_root', msg_type: 'interactive',
      body: { content: body }, observed_at: expect.any(Number),
    }));
    expect(vi.mocked(observePublishedGroupMessage).mock.calls[0]![1]).not.toHaveProperty('update_time');
    submitAskFromDesktop({ askId: snapshot.askId, selections: [['yes']] });
    await answer;
  });

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

  it('submits per-question text from the same live card after another question is toggled', async () => {
    const { snapshot, answer } = await ask({ questions: [
      { ...input.questions[0], allowCustom: true },
      { ...input.questions[0], prompt: '第二题', allowCustom: true },
    ] });
    const toggle = { action: 'ask_toggle', key: 'yes', question_index: '1', custom_form: 'v1', revision: '0' };
    const response = await handleAskCardAction({ context: { open_message_id: 'om_reply' }, operator: { open_id: 'ou_owner' },
      action: { value: { ...toggle, ask_id: snapshot.askId, nonce: snapshot.nonce }, form_value: { custom_0: '自定义社区', custom_1: '' } } }, { larkAppId: 'app' });
    await (response as any)?.afterAck?.();
    await store.update(key, { kind: 'progress', text: '等待确认' }, io);
    expect(JSON.stringify(JSON.parse(body))).toContain('自定义社区');
    await click(snapshot, { action: 'ask_submit', custom_form: 'v1', revision: '1' });
    expect(await answer).toMatchObject({ kind: 'answered', answers: [[], ['yes']], customAnswers: ['自定义社区', null] });
    await Promise.allSettled([...publishing]);
    expect(body).toContain('✓ 自定义社区');
    expect(body).toContain('✓ 继续');
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('preserves multi-select state across worker/CLI patches and empty-submit confirmation', async () => {
    const { snapshot, answer } = await ask({ questions: [{ ...input.questions[0], multiSelect: true }] });
    expect(checker('opt_0_0')).toMatchObject({ checked: false, text: { content: expect.stringContaining('继续') } });
    // A toggle from a card sent before the upgrade still lands in the draft; later patches show it ticked.
    await click(snapshot, { action: 'ask_toggle', key: 'yes', question_index: '0' });
    await store.update(key, { kind: 'phase', phase: 'working' }, io);
    expect(checker('opt_0_0')).toMatchObject({ checked: true });
    expect(body).toContain('等待你确认');
    // The form submitted with every box unticked asks for confirmation, and the armed card shows them unticked.
    await submitForm(snapshot, { action: 'ask_choice_submit' }, { opt_0_0: false, opt_0_1: false });
    await store.update(key, { kind: 'progress', text: '等待你的选择' }, io);
    expect(body).toContain('confirm_empty');
    expect(checker('opt_0_0')).toMatchObject({ checked: false });
    expect(getAskSnapshot(snapshot.askId)?.settled).toBe(false);
    await submitForm(snapshot, { action: 'ask_choice_submit', confirm_empty: 'true' }, { opt_0_0: false, opt_0_1: false });
    expect(await answer).toMatchObject({ kind: 'answered', answers: [[]] });
    expect(body).not.toContain('ask_choice_submit');
    expect(body).not.toContain('"tag":"checker"');
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
    // Drive expiry only after initial publication. A real 150ms deadline can
    // expire during filesystem work on a busy CI runner, before the helper's
    // cardMessageId assertion, without exercising late-snapshot protection.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const answer = registerAsk({ ...input, timeoutMs: 150 });
      const id = _allAskIds().at(-1)!;
      await Promise.all([...publishing]);
      const snapshot = getAskSnapshot(id)!;
      expect(snapshot.cardMessageId).toBe('om_reply');
      expect(snapshot.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(150);
      expect(await answer).toMatchObject({ kind: 'timedOut' });
      await Promise.all([...publishing]);
      await publishReplyCardAsk(snapshot);
      expect(body).toContain('超时未答');
      expect(body).not.toContain('ask_select');
      expect(body).not.toContain('等待你确认');
    } finally {
      vi.useRealTimers();
    }
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
    expect(checker('opt_0_0')).toMatchObject({ checked: true });
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

  it('keeps a native asynchronous question answerable after the originating reply ends', async () => {
    const ds = { larkAppId: 'app', chatId: 'oc_chat', replyCardRunningTurnId: 'om_turn',
      session: { sessionId: 'sid', rootMessageId: 'om_root' } } as DaemonSession;
    const nativeInput = { ...input, originKind: NATIVE_STANDALONE_ASK_ORIGIN };
    const target = replyCardAskTarget(ds, nativeInput, { originTurnId: 'om_turn' });
    expect(target).toBeUndefined();
    const { snapshot, answer } = await ask({ originKind: NATIVE_STANDALONE_ASK_ORIGIN, replyCardTarget: target });
    invalidateReplyCardAsks(key, 'native_task_complete');
    expect(getAskSnapshot(snapshot.askId)?.settled).toBe(false);
    submitAskFromDesktop({ askId: snapshot.askId, selections: [['yes']] });
    expect((await answer).kind).toBe('answered');
  });

  it('admits only a matching running turn and retains independent presentation for oversized questions', () => {
    const ds = { larkAppId: 'app', chatId: 'oc_chat', replyCardRunningTurnId: 'om_turn',
      session: { sessionId: 'sid', rootMessageId: 'om_root' } } as DaemonSession;
    const origin = { originTurnId: 'om_turn' };
    expect(replyCardAskTarget(ds, input, origin)).toEqual(input.replyCardTarget);
    expect(replyCardAskTarget(ds, input, { originTurnId: 'om_other' })).toBeUndefined();
    expect(replyCardAskTarget(ds, { ...input, chatId: 'oc_other' }, origin)).toBeUndefined();
    expect(replyCardAskTarget(ds, input, { ...origin, originDispatchAttempt: 2 })).toBeUndefined();
    expect(replyCardAskTarget(ds, { ...input, mentionedOpenId: 'ou_human' }, origin)).toBeUndefined();
    expect(replyCardAskTarget(ds, { ...input, questions: [{ ...input.questions[0], prompt: '文'.repeat(2000) }] }, origin)).toBeUndefined();
    expect(replyCardAskTarget(ds, { ...input, questions: [{ prompt: 'Details', options: [], multiSelect: false, input: { type: 'text' } }] }, origin)).toBeUndefined();
    const group = { ...ds, scope: 'chat' as const };
    expect(replyCardAskTarget(group, { ...input, rootMessageId: null }, origin)).toEqual(input.replyCardTarget);
    expect(replyCardAskTarget(group, { ...input, rootMessageId: 'oc_chat' }, origin)).toEqual(input.replyCardTarget);
    expect(replyCardAskTarget(group, { ...input, rootMessageId: 'om_other_thread' }, origin)).toBeUndefined();
  });

  // The reply card is re-rendered from server state on every progress/phase/tool PATCH, and
  // Feishu replaces the whole card: anything that lives only in the client until Submit is lost.
  const runningDs = () => ({ larkAppId: 'app', chatId: 'oc_chat', replyCardRunningTurnId: 'om_turn',
    session: { sessionId: 'sid', rootMessageId: 'om_root' } } as DaemonSession);
  const xyz = [{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }, { key: 'z', label: 'Z' }];

  it.each([
    ['带默认勾选的单选', { questions: [{ prompt: 'Which?', allowCustom: false, multiSelect: false, defaultSelectedKeys: ['x'], options: xyz }] }],
    ['多选', { questions: [{ prompt: 'Which?', allowCustom: false, multiSelect: true, options: xyz }] }],
    ['可写备注的单选', { originKind: 'hook', questions: [{ prompt: 'Which?', multiSelect: false, options: xyz }] }],
    ['两道单选', { questions: [input.questions[0], { ...input.questions[0], prompt: '再确认一次？' }] }],
  ] as Array<[string, Partial<CreateAskInput>]>)('表单式提问（%s）不嵌进会被刷新的回复卡', (_shape, overrides) => {
    expect(replyCardAskTarget(runningDs(), { ...input, ...overrides }, { originTurnId: 'om_turn' })).toBeUndefined();
  });

  it('回复卡刷新进度时，用户在表单上还没提交的勾选和备注不受影响', async () => {
    const formAsk: CreateAskInput = { ...input, originKind: 'hook',
      questions: [{ prompt: 'Which?', multiSelect: true, defaultSelectedKeys: ['x'], options: xyz }] };
    const replyCardTarget = replyCardAskTarget(runningDs(), formAsk, { originTurnId: 'om_turn' });
    let askCard = '';
    vi.mocked(replyMessage).mockImplementation(async (_app, _root, content) => { askCard = content; return 'om_ask'; });
    const patched: string[] = [];
    vi.mocked(updateMessage).mockImplementation(async (_app, id, content) => { patched.push(id); body = content; });
    const answer = registerAsk({ ...formAsk, replyCardTarget });
    const id = _allAskIds().at(-1)!;
    await vi.waitFor(() => expect(getAskSnapshot(id)?.cardMessageId).toBe('om_ask'));
    await Promise.allSettled([...publishing]);

    // While the user unticks X, ticks Y and Z and writes a note on the client, the turn reports progress.
    await store.update(key, { kind: 'progress', text: 'background step done' }, io);
    await store.update(key, { kind: 'progress', text: 'another step' }, io);
    expect(patched.length).toBeGreaterThan(0);
    expect(patched.every(messageId => messageId === 'om_reply')).toBe(true);
    expect(store.read(key)?.asks).toBeUndefined();

    // The form the user is editing was never re-rendered, so Submit carries their draft.
    const nodes = cardNodes(JSON.parse(askCard));
    const submit = nodes.find((n: any) => n.tag === 'button' && n.form_action_type === 'submit');
    const value = submit.value ?? submit.behaviors?.find((b: any) => b.type === 'callback')?.value;
    const checkerNames = nodes.filter((n: any) => n.tag === 'checker').map((n: any) => n.name);
    const noteName = nodes.find((n: any) => n.tag === 'input')?.name;
    const response = await handleAskCardAction({ operator: { open_id: 'ou_owner' }, context: { open_message_id: 'om_ask' },
      action: { value, form_value: { [checkerNames[0]]: false, [checkerNames[1]]: true, [checkerNames[2]]: true, [noteName]: '下午再做' } } },
    { larkAppId: 'app', requestGrant: () => 'unavailable' });
    await (response as { afterAck?: () => Promise<void> })?.afterAck?.();
    expect(await answer).toMatchObject({ kind: 'answered', answers: [['y', 'z']], notes: ['下午再做'] });
  });

  it.each([
    ['一键单选', input],
    ['权限确认', { ...input, originKind: 'hook', questions: [{ prompt: '允许执行 rm -rf build 吗？', allowCustom: false, multiSelect: false,
      options: [{ key: 'allow', label: '允许' }, { key: 'deny', label: '拒绝' }] }] }],
  ] as Array<[string, CreateAskInput]>)('点一下就答完的提问（%s）仍嵌在回复卡里', async (_shape, oneClick) => {
    const replyCardTarget = replyCardAskTarget(runningDs(), oneClick, { originTurnId: 'om_turn' });
    expect(replyCardTarget).toEqual({ turnId: 'om_turn' });
    const { snapshot, answer } = await ask({ ...oneClick, replyCardTarget });
    expect(store.read(key)?.asks?.map(entry => entry.ask.askId)).toEqual([snapshot.askId]);
    await click(snapshot, { action: 'ask_select', key: oneClick.questions[0]!.options[0]!.key });
    expect(await answer).toMatchObject({ kind: 'answered', answers: [[oneClick.questions[0]!.options[0]!.key]] });
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
    // A standalone card answers in the callback response itself (a whole card, not a reply-card refresh).
    const response = await handleAskCardAction({ operator: { open_id: 'ou_owner' }, context: { open_message_id: 'om_reply' },
      action: { value: { action: 'ask_select', key: 'yes', ask_id: snapshot.askId, nonce: snapshot.nonce } } }, { larkAppId: 'app' });
    expect(response).toMatchObject({ schema: '2.0', header: { template: 'green' } });
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

describe('buildTurnReplyAskElements — 选项说明', () => {
  // All Markdown text of the embedded Ask, however deeply it is nested.
  const notes = (node: unknown): string => !node || typeof node !== 'object' ? ''
    : Array.isArray(node) ? node.map(notes).join('\n')
      : [(node as any).tag === 'markdown' ? (node as any).content : '', ...Object.values(node).map(notes)].filter(Boolean).join('\n');

  it('文字作答批次不画按钮，但选项说明照常展示', () => {
    const elements = buildTurnReplyAskElements(inlineAskWithQuestions([
      { prompt: '发布方式', multiSelect: false, options: [
        { key: 'gray', label: '灰度', description: '先放 5% 流量观察' },
        { key: 'full', label: '全量', description: '立即放开所有流量' },
      ] },
      { prompt: '补充说明', multiSelect: false, options: [], inputMode: 'text' },
    ]));
    expect(notes(elements)).toContain('先放 5% 流量观察');
    expect(notes(elements)).toContain('立即放开所有流量');
    expect(JSON.stringify(elements)).not.toMatch(/ask_select|ask_toggle/);
  });

  it('选项里的 at 标签不会变成真实点名，实体解码后也不会', () => {
    const elements = buildTurnReplyAskElements(inlineAskWithQuestions([
      { prompt: '选择', multiSelect: false, options: [
        { key: 'a', label: '<at id=ou_label></at>', description: '<at id=all></at> 和 <at id=ou_desc></at>' },
        { key: 'b', label: 'B' },
      ] },
    ]));
    expect(notes(elements).replace(/&lt;/g, '<').replace(/&gt;/g, '>')).not.toMatch(/<at\b/);
  });

  // replyCardAskTarget admits at most 3000 bytes of questions JSON. `<` grows fourfold once
  // escaped, and a described label is drawn twice in a text batch: the two worst shapes.
  const fillGate = (questions: (n: number) => PendingAsk['questions']) => {
    let n = 0;
    while (Buffer.byteLength(JSON.stringify(questions(n + 1)), 'utf8') <= 3000) n++;
    return questions(n);
  };
  it.each([
    ['长说明', fillGate(n => [{ prompt: '选择', allowCustom: false, multiSelect: false, options: [
      { key: 'a', label: 'A', description: `${'<'.repeat(n)}TAIL-A` },
      { key: 'b', label: 'B', description: `${'<'.repeat(n)}TAIL-B` },
    ] }])],
    ['文字批次里的长标签', fillGate(n => [
      { prompt: '选择', allowCustom: false, multiSelect: false, options: [
        { key: 'a', label: `${'<'.repeat(n)}A`, description: 'TAIL-A' },
        { key: 'b', label: `${'<'.repeat(n)}B`, description: 'TAIL-B' },
      ] },
      { prompt: '补充', multiSelect: false, options: [], inputMode: 'text' },
    ])],
  ])('能进回复卡的最大选项说明完整展示，整卡仍在请求体上限内（%s）', async (_shape, questions) => {
    const ds = { larkAppId: 'app', chatId: 'oc_chat', replyCardRunningTurnId: 'om_turn',
      session: { sessionId: 'sid', rootMessageId: 'om_root' } } as DaemonSession;
    expect(replyCardAskTarget(ds, { ...input, questions }, { originTurnId: 'om_turn' })).toBeDefined();
    await ask({ questions });
    expect(body).toContain('TAIL-A');
    expect(body).toContain('TAIL-B');
    expect(turnReplyCardRequestBytes(body, 'oc_chat')).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
  });
});
