import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetForTest, _pendingCount, findPendingAskByAnchor, registerAsk,
  registerHostAsk, setCardDispatcher, setCanTalkChecker, submitCustomReply,
  tryResolveAsk,
} from '../src/core/ask-broker.js';
import { registerAskForResponse } from '../src/core/ask-api.js';
import type { CreateAskInput, PendingAsk, AskResult } from '../src/core/ask-types.js';

const input: CreateAskInput = {
  larkAppId: 'app', chatId: 'chat', rootMessageId: null, sessionId: 'session',
  questions: [{ prompt: 'Continue?', multiSelect: false,
    options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] }],
  timeoutMs: 60_000, originKind: 'explicit', requestId: 'request',
};
const anchor = { larkAppId: 'app', chatId: 'chat', anchor: 'chat' };
let cards: PendingAsk[];
let settled: Array<{ ask: PendingAsk; result: AskResult }>;
beforeEach(() => {
  _resetForTest();
  cards = []; settled = [];
  setCanTalkChecker(() => true);
  setCardDispatcher({
    async send(ask) { cards.push(ask); return { messageId: 'card' }; },
    onSettle(ask, result) { settled.push({ ask, result }); },
  });
});
afterEach(() => { _resetForTest(); });
const answer = () => submitCustomReply({ askId: cards[0].askId, by: 'user', text: 'A follow-up question' });

describe('ask caller lifetime', () => {
  it('invalidates an abandoned explicit ask so subsequent text falls through', async () => {
    const controller = new AbortController();
    const result = registerAsk(input, controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(await result).toMatchObject({ kind: 'invalidated' });
    expect(findPendingAskByAnchor(anchor)).toBeUndefined();
    expect(answer()).toBe('already_settled');
    expect(tryResolveAsk({ askId: cards[0].askId, nonce: cards[0].nonce, selected: 'yes', by: 'user' })).toBe('already_settled');
    expect(_pendingCount()).toBe(0);
    expect(settled).toHaveLength(1);
  });

  it('marks a card terminal when delivery finishes after the caller disconnects', async () => {
    let delivered!: (value: { messageId: string }) => void;
    setCardDispatcher({
      send(ask) {
        cards.push(ask);
        return new Promise((resolve) => { delivered = resolve; });
      },
      onSettle(ask, result) { settled.push({ ask, result }); },
    });
    const controller = new AbortController();
    const result = registerAsk(input, controller.signal);
    controller.abort(); await result;
    delivered({ messageId: 'late-card' });
    await Promise.resolve();
    expect(settled.at(-1)).toMatchObject({
      ask: { cardMessageId: 'late-card' }, result: { kind: 'invalidated' },
    });
    expect(findPendingAskByAnchor(anchor)).toBeUndefined();
  });

  it('does not create a card for an already disconnected caller', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await registerAsk(input, controller.signal)).toMatchObject({ kind: 'invalidated' });
    expect(cards).toHaveLength(0);
  });

  it('keeps a shared ask until its last waiter disconnects', async () => {
    const a = new AbortController(); const b = new AbortController();
    const first = registerAsk(input, a.signal); const second = registerAsk(input, b.signal);
    a.abort();
    expect(await first).toMatchObject({ kind: 'invalidated' });
    expect(_pendingCount()).toBe(1);
    expect(answer()).toBe('accepted');
    expect(await second).toMatchObject({ kind: 'answered' });
    b.abort();
    expect(cards).toHaveLength(1);
    expect(settled).toHaveLength(1);
  });

  it('invalidates after both joined waiters disconnect', async () => {
    const a = new AbortController(); const b = new AbortController();
    const first = registerAsk(input, a.signal); const second = registerAsk(input, b.signal);
    a.abort(); b.abort();
    await Promise.all([first, second]);
    expect(findPendingAskByAnchor(anchor)).toBeUndefined();
  });

  it('preserves restart-safe hook answers for reconnect without posting another card', async () => {
    const hook = { ...input, originKind: 'hook', backendSurvivesRestart: true };
    const controller = new AbortController();
    const first = registerAsk(hook, controller.signal);
    controller.abort();
    await first;
    expect(answer()).toBe('accepted');
    expect(await registerAsk(hook)).toMatchObject({ kind: 'answered', comment: 'A follow-up question' });
    expect(cards).toHaveLength(1);
  });

  it('reattaches a hook before the answer and still tracks the new connection', async () => {
    const hook = { ...input, originKind: 'hook', backendSurvivesRestart: true };
    const a = new AbortController(); const b = new AbortController();
    const first = registerAsk(hook, a.signal);
    await Promise.resolve();
    a.abort(); await first;
    const second = registerAsk(hook, b.signal);
    b.abort(); await second;
    expect(answer()).toBe('accepted');
    expect(await registerAsk(hook)).toMatchObject({ kind: 'answered' });
    expect(cards).toHaveLength(1);
  });

  it('leaves host-owned cards independently answerable', async () => {
    const result = registerHostAsk({ ...input, originKind: 'host_cross_principal_test' });
    expect(answer()).toBe('accepted');
    expect(await result).toMatchObject({ kind: 'answered' });
  });

  it('removes abort listeners when a connected caller receives an answer', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = registerAsk(input, controller.signal);
    await Promise.resolve();
    expect(answer()).toBe('accepted');
    await result;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(settled).toHaveLength(1);
  });
});

it.each(['disconnect', 'answer'] as const)('real HTTP POST completion keeps waiting until %s', async (outcome) => {
  let finished: Promise<AskResult> | undefined;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* fully consume the POST body */ }
    finished = registerAskForResponse(input, res);
    const result = await finished;
    if (!res.destroyed) res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const client = request({ host: '127.0.0.1', port: address.port, method: 'POST' });
  client.on('error', () => {});
  const responseBody = outcome === 'answer'
    ? new Promise<string>((resolve) => {
      client.on('response', async (res) => {
        let body = '';
        for await (const chunk of res) body += chunk;
        resolve(body);
      });
    })
    : undefined;
  try {
    client.end('{}');
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    expect(_pendingCount()).toBe(1);
    if (outcome === 'disconnect') {
      client.destroy();
      await vi.waitFor(() => expect(_pendingCount()).toBe(0));
      expect(await finished).toMatchObject({ kind: 'invalidated' });
    } else {
      expect(answer()).toBe('accepted');
      expect(JSON.parse((await responseBody)!)).toMatchObject({ kind: 'answered' });
      expect(await finished).toMatchObject({ kind: 'answered' });
    }
    expect(findPendingAskByAnchor(anchor)).toBeUndefined();
    expect(answer()).toBe('already_settled');
  } finally {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
