import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PendingAsk } from '../src/core/ask-types.js';
import {
  _getPending,
  _resetForTest,
  registerAsk,
  setCardDispatcher,
} from '../src/core/ask-broker.js';
import {
  ASK_SELECT_ACTION,
  buildAskCard,
  createLarkAskCardDispatcher,
  handleAskCardAction,
} from '../src/im/lark/ask-card.js';

afterEach(() => {
  _resetForTest();
});

function pendingAsk(overrides: Partial<PendingAsk> = {}): PendingAsk {
  return {
    askId: 'ask-1',
    nonce: 'nonce-1',
    larkAppId: 'cli_ask',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    sessionId: 'sess-1',
    approvers: new Set(['ou_owner']),
    options: [
      { key: 'deploy', label: '继续发布' },
      { key: 'rollback', label: '回滚' },
      { key: 'abort', label: '中止' },
    ],
    prompt: '线上 latency 涨了 30%，下一步怎么处理？',
    createdAt: 1_000,
    deadlineAt: 1_000 + 300_000,
    settled: false,
    ...overrides,
  };
}

describe('buildAskCard', () => {
  it('renders prompt, approvers, and button action values', () => {
    const card = JSON.parse(buildAskCard(pendingAsk()));
    const text = JSON.stringify(card);

    expect(card.header.title.content).toBe('botmux ask');
    expect(text).toContain('线上 latency');
    expect(card.elements[1].fields[1].text.content).toContain('ou\\_owner');
    expect(text).toContain(ASK_SELECT_ACTION);
    expect(text).toContain('"ask_id":"ask-1"');
    expect(text).toContain('"nonce":"nonce-1"');
    expect(text).toContain('"key":"deploy"');
    expect(text).toContain('继续发布');
  });

  it('wraps options into column rows of at most four buttons', () => {
    const card = JSON.parse(
      buildAskCard(
        pendingAsk({
          options: [
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
            { key: 'c', label: 'C' },
            { key: 'd', label: 'D' },
            { key: 'e', label: 'E' },
          ],
        }),
      ),
    );

    const rows = card.elements.filter((e: any) => e.tag === 'column_set');
    expect(rows).toHaveLength(2);
    expect(rows[0].columns).toHaveLength(4);
    expect(rows[1].columns).toHaveLength(1);
  });

  it('renders settled answered cards without live buttons', () => {
    const card = JSON.parse(
      buildAskCard(pendingAsk(), {
        kind: 'answered',
        selected: 'rollback',
        by: 'ou_owner',
        comment: null,
        timedOut: false,
      }),
    );
    const text = JSON.stringify(card);

    expect(card.header.template).toBe('green');
    expect(text).toContain('已选择');
    expect(text).toContain('回滚');
    expect(text).not.toContain(ASK_SELECT_ACTION);
  });
});

describe('handleAskCardAction', () => {
  it('resolves a pending ask and returns no toast for accepted clicks', async () => {
    let askId = '';
    setCardDispatcher({
      async send(ask) {
        askId = ask.askId;
        return { messageId: 'om_ask' };
      },
    });
    const promise = registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      approvers: new Set(['ou_owner']),
      options: pendingAsk().options,
      prompt: 'choose',
      timeoutMs: 10_000,
    });
    await Promise.resolve();
    const pending = _getPending(askId);
    expect(pending).toBeDefined();

    const result = handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: ASK_SELECT_ACTION,
          ask_id: askId,
          nonce: 'should-not-match',
          key: 'deploy',
        },
      },
    });
    expect(result?.toast.content).toContain('失效');

    const accepted = handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: ASK_SELECT_ACTION,
          ask_id: askId,
          nonce: pending!.nonce,
          key: 'deploy',
        },
      },
    });
    expect(accepted).toBeUndefined();
    await expect(promise).resolves.toMatchObject({ kind: 'answered', selected: 'deploy', by: 'ou_owner' });
  });

  it('returns a warning toast for non-approvers', async () => {
    let captured: PendingAsk | undefined;
    setCardDispatcher({
      async send(ask) {
        captured = ask;
        return { messageId: 'om_ask' };
      },
    });
    registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      approvers: new Set(['ou_owner']),
      options: pendingAsk().options,
      prompt: 'choose',
      timeoutMs: 10_000,
    });
    await Promise.resolve();

    const result = handleAskCardAction({
      operator: { open_id: 'ou_intruder' },
      action: {
        value: {
          action: ASK_SELECT_ACTION,
          ask_id: captured!.askId,
          nonce: captured!.nonce,
          key: 'deploy',
        },
      },
    });
    expect(result?.toast.type).toBe('warning');
    expect(result?.toast.content).toContain('没有权限');
  });
});

describe('createLarkAskCardDispatcher', () => {
  it('replies into the root thread when rootMessageId exists', async () => {
    const reply = vi.fn(async () => 'om_reply');
    const send = vi.fn(async () => 'om_send');
    const dispatcher = createLarkAskCardDispatcher({ replyMessage: reply as any, sendMessage: send as any });

    await expect(dispatcher.send(pendingAsk())).resolves.toEqual({ messageId: 'om_reply' });
    expect(reply).toHaveBeenCalledWith('cli_ask', 'om_root', expect.any(String), 'interactive', true);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends to chat when rootMessageId is absent and patches on settle', async () => {
    const update = vi.fn(async () => undefined);
    const send = vi.fn(async () => 'om_send');
    const dispatcher = createLarkAskCardDispatcher({ sendMessage: send as any, updateMessage: update as any });
    const ask = pendingAsk({ rootMessageId: null, cardMessageId: 'om_card' });

    await expect(dispatcher.send(ask)).resolves.toEqual({ messageId: 'om_send' });
    expect(send).toHaveBeenCalledWith('cli_ask', 'oc_chat', expect.any(String), 'interactive');

    await dispatcher.onSettle?.(ask, {
      kind: 'timedOut',
      selected: null,
      by: null,
      comment: null,
      timedOut: true,
    });
    expect(update).toHaveBeenCalledWith('cli_ask', 'om_card', expect.stringContaining('超时'));
  });
});
