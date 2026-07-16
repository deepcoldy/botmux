import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  reply: vi.fn(),
  emitHookEvent: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({
    im: { v1: { message: { create: mocks.create, reply: mocks.reply } } },
  }),
  getAllBots: () => [],
  getBot: vi.fn(),
  formatLarkError: (value: unknown) => String(value),
  loadBotConfigs: () => [],
}));

vi.mock('../src/services/hook-runner.js', () => ({
  emitHookEvent: mocks.emitHookEvent,
}));

import { replyMessage, sendMessage } from '../src/im/lark/client.js';

describe('Lark outbound hook provider replay suppression', () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_send' } });
    mocks.reply.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_reply' } });
    mocks.emitHookEvent.mockReset();
  });

  it('keeps the ordinary first-send hook', async () => {
    await sendMessage('app', 'oc_chat', 'answer', 'text', 'stable-uuid', { sessionId: 'sid' });

    expect(mocks.emitHookEvent).toHaveBeenCalledOnce();
    expect(mocks.emitHookEvent).toHaveBeenCalledWith('outbound.send', expect.objectContaining({
      messageId: 'om_send',
      uuid: 'stable-uuid',
      sessionId: 'sid',
    }));
  });

  it('does not repeat send/reply hooks while reconciling an accepted provider UUID', async () => {
    await sendMessage(
      'app',
      'oc_chat',
      'answer',
      'text',
      'stable-send',
      { sessionId: 'sid' },
      { suppressHook: true },
    );
    await replyMessage(
      'app',
      'om_parent',
      'answer',
      'text',
      true,
      'stable-reply',
      { sessionId: 'sid' },
      { suppressHook: true },
    );

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.reply).toHaveBeenCalledOnce();
    expect(mocks.emitHookEvent).not.toHaveBeenCalled();
  });
});
