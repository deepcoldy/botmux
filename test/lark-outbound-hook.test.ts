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

  it('fences the post-provider hook and forwards its frozen managed origin', async () => {
    const beforeHook = vi.fn(async () => {});
    const hookOrigin = {
      ipcPort: 4310,
      sessionId: 'sid',
      capability: 'ab'.repeat(32),
      turnId: 'turn-1',
      dispatchAttempt: 2,
    };
    await sendMessage(
      'app', 'oc_chat', 'answer', 'text', undefined, { sessionId: 'sid' },
      { beforeHook, hookOrigin },
    );

    expect(beforeHook).toHaveBeenCalledOnce();
    expect(mocks.create.mock.invocationCallOrder[0])
      .toBeLessThan(beforeHook.mock.invocationCallOrder[0]!);
    expect(beforeHook.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.emitHookEvent.mock.invocationCallOrder[0]!);
    expect(mocks.emitHookEvent).toHaveBeenCalledWith(
      'outbound.send',
      expect.objectContaining({ messageId: 'om_send', content: 'answer' }),
      { managedOrigin: hookOrigin },
    );
  });

  it('drops only the hook when authority is revoked after provider acceptance', async () => {
    const beforeHook = vi.fn(async () => { throw new Error('origin rotated'); });
    await expect(sendMessage(
      'app', 'oc_chat', 'answer', 'text', undefined, { sessionId: 'sid' },
      { beforeHook },
    )).resolves.toBe('om_send');
    expect(beforeHook).toHaveBeenCalledOnce();
    expect(mocks.emitHookEvent).not.toHaveBeenCalled();
  });
});
