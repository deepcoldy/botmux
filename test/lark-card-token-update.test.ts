import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  request: vi.fn(),
}));

vi.mock('../src/im/lark/api-gate.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/im/lark/api-gate.js')>(),
  executeWithLarkGate: mocks.gate,
}));

vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/bot-registry.js')>(),
  getBot: () => ({
    config: { larkAppId: 'app', larkAppSecret: 'secret', apiOnly: false },
    botOpenId: 'ou_bot',
  }),
  getBotClient: () => ({ request: mocks.request }),
  getAllBots: () => [],
  loadBotConfigs: () => [],
  formatLarkError: (error: unknown) => String(error),
}));

import { updateInteractiveCardByToken } from '../src/im/lark/client.js';

describe('updateInteractiveCardByToken', () => {
  beforeEach(() => {
    mocks.gate.mockReset().mockImplementation(async (_app, _op, fn) => await fn());
    mocks.request.mockReset().mockResolvedValue({ code: 0 });
  });

  it('sends the delayed-update body with callback markers and a two-attempt token budget', async () => {
    await updateInteractiveCardByToken('app', 'c_callback', {
      schema: '2.0',
      config: { update_multi: true },
      body: { elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '确认' },
        behaviors: [{ type: 'callback', value: { action: 'faas.confirm' } }],
      }] },
    });

    expect(mocks.gate).toHaveBeenCalledOnce();
    expect(mocks.gate.mock.calls[0][0]).toBe('app');
    expect(mocks.gate.mock.calls[0][1]).toBe('updateInteractiveCardByToken');
    expect(mocks.gate.mock.calls[0][3]).toEqual({ retryMaxAttempts: 1 });
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      url: '/open-apis/interactive/v1/card/update',
      data: {
        token: 'c_callback',
        card: { schema: '2.0', config: { update_multi: true } },
      },
    });
    expect(mocks.request.mock.calls[0][0].data.card.body.elements[0].behaviors[0].value)
      .toEqual({ action: 'faas.confirm', __bm_cb: 1 });
  });

  it('surfaces a nonzero Lark acknowledgement instead of reporting success', async () => {
    mocks.request.mockResolvedValueOnce({ code: 300040, msg: 'token usage exhausted' });
    await expect(updateInteractiveCardByToken('app', 'c_used', { schema: '2.0', body: { elements: [] } }))
      .rejects.toMatchObject({ code: 300040 });
  });
});
