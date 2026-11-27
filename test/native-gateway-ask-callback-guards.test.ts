/**
 * What a native gateway callback must prove before the broker acts on it:
 * the exact execution, an ask that execution can see, the ask's nonce, and a
 * concrete responder that satisfies the ask's own responder lock. Real broker
 * and real native gateway dispatcher; the gateway itself is the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetForTest, listPendingAsks, registerAsk, setCardDispatcher } from '../src/core/ask-broker.js';
import { createNativeGatewayAskDispatcher } from '../src/core/native-gateway-ask-dispatch.js';
import { nativeGatewayAskDecision, nativeGatewayAskSnapshots, type NativeGatewayAskOrigin } from '../src/core/native-gateway-ask-control.js';
import { buildWecomAskCard, wecomAskCardEvent, type NativeAskState } from '../src/im/wecom/gateway/native-ask.js';
import type { WecomCardEvent, WecomTemplateCard } from '../src/im/wecom/protocol/types.js';
import type { AskResult, CreateAskInput, PendingAsk } from '../src/core/ask-types.js';

const APP = 'local_bot';
const CHAT = 'http_async_fixture';
const current: NativeGatewayAskOrigin = { sessionId: 'session', turnId: 'turn', workerGeneration: 2, dispatchAttempt: 4 };
const choice = [{ prompt: 'Proceed?', multiSelect: false, options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] }];

function ask(requestId: string, overrides: Partial<CreateAskInput> = {}, at: NativeGatewayAskOrigin = current): Promise<AskResult> {
  return registerAsk({
    larkAppId: APP, chatId: CHAT, sessionId: at.sessionId, rootMessageId: null, questions: choice, timeoutMs: 600_000,
    requestId, originKind: 'hook',
    nativeGatewayOrigin: { turnId: at.turnId, workerGeneration: at.workerGeneration, dispatchAttempt: at.dispatchAttempt },
    ...overrides,
  });
}

function pendingFor(requestPrompt?: string): PendingAsk {
  const asks = listPendingAsks();
  const found = requestPrompt ? asks.find(item => item.questions[0]?.prompt === requestPrompt) : asks[0];
  if (!found) throw new Error('no pending ask');
  return found;
}

function decide(body: Record<string, unknown>): string {
  return nativeGatewayAskDecision({ origin: current, ...body }, current, APP, CHAT);
}

async function stillWaiting(result: Promise<AskResult>): Promise<AskResult | 'still-waiting'> {
  return Promise.race([result, vi.advanceTimersByTimeAsync(1).then(() => 'still-waiting' as const)]);
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTest();
  setCardDispatcher(createNativeGatewayAskDispatcher());
});

afterEach(() => {
  _resetForTest();
  vi.useRealTimers();
});

describe('which asks a gateway sees', () => {
  it('lists only asks of the exact execution: same session, chat, turn, worker generation and dispatch attempt', async () => {
    void ask('exact');
    const others: Array<[string, NativeGatewayAskOrigin, Partial<CreateAskInput>?]> = [
      ['older-generation', { ...current, workerGeneration: current.workerGeneration - 1 }],
      ['earlier-attempt', { ...current, dispatchAttempt: current.dispatchAttempt! - 1 }],
      ['other-turn', { ...current, turnId: 'other-turn' }],
      ['other-session', { ...current, sessionId: 'other-session' }],
      ['other-chat', current, { chatId: 'http_other_fixture' }],
      ['other-app', current, { larkAppId: 'local_other_bot' }],
    ];
    for (const [requestId, at, overrides] of others) {
      void ask(requestId, { questions: [{ ...choice[0]!, prompt: requestId }], ...overrides }, at);
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(listPendingAsks()).toHaveLength(7);
    expect(nativeGatewayAskSnapshots(current, APP, CHAT).map(item => item.ask.questions[0]?.prompt)).toEqual(['Proceed?']);
  });

  it('refuses a callback for an ask of another execution even when it names the current one', async () => {
    const elsewhere = ask('elsewhere', {}, { ...current, workerGeneration: current.workerGeneration - 1 });
    await vi.advanceTimersByTimeAsync(1);
    const other = pendingFor();
    expect(decide({ action: 'toggle', askId: other.askId, nonce: other.nonce, by: 'alice', questionIndex: 0, key: 'yes' })).toBe('stale');
    expect(decide({ action: 'submit', askId: other.askId, nonce: other.nonce, by: 'alice' })).toBe('stale');
    await expect(stillWaiting(elsewhere)).resolves.toBe('still-waiting');
  });
});

describe('nonce', () => {
  it('a delivery receipt must carry the ask nonce', async () => {
    void ask('delivery');
    await vi.advanceTimersByTimeAsync(1);
    const pending = pendingFor();
    expect(decide({ action: 'delivered', askId: pending.askId, nonce: 'forged', messageId: 'card' })).toBe('stale');
    expect(decide({ action: 'delivered', askId: pending.askId, nonce: pending.nonce, messageId: 42 })).toBe('stale');
    expect(pendingFor().cardMessageId).toBeUndefined();
    expect(decide({ action: 'delivered', askId: pending.askId, nonce: pending.nonce, messageId: 'card' })).toBe('accepted');
  });

  it('a text answer must carry the ask nonce', async () => {
    const result = ask('text', { questions: [{ prompt: 'Explain', options: [], multiSelect: false, inputMode: 'text' }] });
    await vi.advanceTimersByTimeAsync(1);
    const pending = pendingFor();
    expect(decide({ action: 'text', askId: pending.askId, nonce: 'forged', by: 'alice', text: 'forged answer' })).toBe('stale');
    await expect(stillWaiting(result)).resolves.toBe('still-waiting');
    expect(decide({ action: 'text', askId: pending.askId, nonce: pending.nonce, by: 'alice', text: 'real answer' })).toBe('accepted');
    await expect(result).resolves.toMatchObject({ kind: 'answered', comment: 'real answer' });
  });
});

describe('action', () => {
  it('an unknown action is refused rather than taken as an answer', async () => {
    const result = ask('action', { questions: [{ prompt: 'Explain', options: [], multiSelect: false, inputMode: 'text' }] });
    await vi.advanceTimersByTimeAsync(1);
    const pending = pendingFor();
    expect(decide({ action: 'answer', askId: pending.askId, nonce: pending.nonce, by: 'alice', text: 'anything' })).toBe('unauthorized');
    await expect(stillWaiting(result)).resolves.toBe('still-waiting');
  });
});

describe('responder', () => {
  it('must be a concrete platform user id', async () => {
    const result = ask('responder');
    await vi.advanceTimersByTimeAsync(1);
    const pending = pendingFor();
    const submit = (by: unknown) => decide({ action: 'submit', askId: pending.askId, nonce: pending.nonce, by });
    expect(decide({ action: 'toggle', askId: pending.askId, nonce: pending.nonce, by: 'alice', questionIndex: 0, key: 'yes' })).toBe('toggled');
    for (const by of ['', 'alice bob', 'alice\0', 'a'.repeat(10_000), undefined, 42]) expect(submit(by)).toBe('unauthorized');
    await expect(stillWaiting(result)).resolves.toBe('still-waiting');
    expect(submit('alice')).toBe('accepted');
    await expect(result).resolves.toMatchObject({ kind: 'answered', by: 'alice' });
  });

  it('must satisfy the ask responder lock', async () => {
    const result = ask('locked', { answererOpenId: 'alice' });
    await vi.advanceTimersByTimeAsync(1);
    const pending = pendingFor();
    const toggle = (by: string) => decide({ action: 'toggle', askId: pending.askId, nonce: pending.nonce, by, questionIndex: 0, key: 'yes' });
    expect(toggle('bob')).toBe('unauthorized');
    expect(pendingFor().selections).toEqual([[]]);
    expect(toggle('alice')).toBe('toggled');
    expect(decide({ action: 'submit', askId: pending.askId, nonce: pending.nonce, by: 'bob' })).toBe('unauthorized');
    await expect(stillWaiting(result)).resolves.toBe('still-waiting');
    expect(decide({ action: 'submit', askId: pending.askId, nonce: pending.nonce, by: 'alice' })).toBe('accepted');
    await expect(result).resolves.toMatchObject({ kind: 'answered', by: 'alice' });
  });
});

describe('a repeated answer', () => {
  it('to an ask already answered in this execution is reported as already settled, not as a stale card', async () => {
    const result = ask('repeat');
    await vi.advanceTimersByTimeAsync(1);
    const pending = pendingFor();
    const ids = { askId: pending.askId, nonce: pending.nonce };
    expect(decide({ action: 'toggle', ...ids, by: 'alice', questionIndex: 0, key: 'yes' })).toBe('toggled');
    expect(decide({ action: 'submit', ...ids, by: 'alice' })).toBe('accepted');
    expect(decide({ action: 'submit', ...ids, by: 'bob' })).toBe('already_settled');
    expect(decide({ action: 'submit', ...ids, by: 'alice', nonce: 'forged' })).toBe('stale');
    expect(decide({ action: 'delivered', ...ids, messageId: 'card' })).toBe('stale');
    await expect(result).resolves.toMatchObject({ kind: 'answered', by: 'alice' });
  });

  it('to an ask that ended unanswered is still a stale card', async () => {
    const result = ask('ended', { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1);
    const pending = pendingFor();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ kind: 'timedOut' });
    expect(decide({ action: 'submit', askId: pending.askId, nonce: pending.nonce, by: 'alice' })).toBe('stale');
  });

  it('from a double click leaves the WeCom card showing the submitted answer', async () => {
    const result = ask('double-click');
    await vi.advanceTimersByTimeAsync(1);
    const [snapshot] = nativeGatewayAskSnapshots(current, APP, CHAT);
    expect(decide({ action: 'delivered', askId: snapshot!.ask.askId, nonce: snapshot!.ask.nonce, messageId: 'card' })).toBe('accepted');
    const card = buildWecomAskCard(snapshot!);
    const state: NativeAskState = { nativeAsks: { [card.task_id!]: {
      snapshot: snapshot!, conversationId: 'alice', recipient: 'alice', requester: 'alice', chatType: 'single', status: 'sent', eventIds: {},
    } } };
    const updates: WecomTemplateCard[] = [];
    const core = {
      asks: async () => nativeGatewayAskSnapshots(current, APP, CHAT),
      answerAsk: async (_sessionId: string, body: Record<string, unknown>) => ({ outcome: nativeGatewayAskDecision(body, current, APP, CHAT) }),
    };
    const click = (eventKey: string, messageId: string) => wecomAskCardEvent({
      state, core, policy: {}, save: () => {}, allowed: () => true, update: async next => { updates.push(next); },
      event: { messageId, botId: 'bot', userId: 'alice', conversationId: 'alice', chatType: 'single', requestId: 'callback',
        taskId: card.task_id!, eventKey, receivedAt: Date.now() } satisfies WecomCardEvent,
    });
    await click('ask:toggle:0:0', 'e1');
    await click('ask:submit', 'e2');
    await click('ask:submit', 'e3');
    await expect(result).resolves.toMatchObject({ kind: 'answered', by: 'alice' });
    expect(updates.at(-1)).toMatchObject({ card_type: 'text_notice' });
    expect(updates.filter(update => update.card_type === 'text_notice')).toHaveLength(1);
  });
});
