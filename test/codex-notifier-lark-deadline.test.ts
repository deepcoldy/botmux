import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  request: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({
    request: mocks.request,
    im: { v1: { message: { create: mocks.create } } },
  }),
  getAllBots: () => [],
  getBot: vi.fn(),
  formatLarkError: (value: unknown) => String(value),
  loadBotConfigs: () => [],
}));

vi.mock('../src/services/hook-runner.js', () => ({
  emitHookEvent: vi.fn(),
  // sendUserMessage now asks the outbound.pre_send gate before hitting Lark;
  // with no sync hook configured the real one allows without spawning.
  evaluatePromptGate: vi.fn(async () => ({ allowed: true })),
  hasSyncGateHooks: vi.fn(() => false),
}));

import { getMessageChatId, sendUserMessage } from '../src/im/lark/client.js';

describe('Codex notifier Lark request deadlines', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.request.mockReset();
  });

  it('passes timeout and AbortSignal to the SDK generic DM request', async () => {
    const controller = new AbortController();
    mocks.request.mockResolvedValue({ code: 0, data: { message_id: 'om_card' } });

    await expect(sendUserMessage(
      'app',
      'ou_owner',
      '{"schema":"2.0"}',
      'interactive',
      'stable-uuid',
      { timeoutMs: 1_234, signal: controller.signal },
    )).resolves.toBe('om_card');

    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: '/open-apis/im/v1/messages',
      params: { receive_id_type: 'open_id' },
      timeout: 1_234,
      signal: controller.signal,
      data: expect.objectContaining({
        receive_id: 'ou_owner',
        msg_type: 'interactive',
        uuid: 'stable-uuid',
      }),
    }));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('keeps the generated SDK path for existing unbounded callers', async () => {
    mocks.create.mockResolvedValue({ code: 0, data: { message_id: 'om_legacy' } });
    await expect(sendUserMessage('app', 'ou_owner', 'hello')).resolves.toBe('om_legacy');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('lets an AbortSignal cancel an in-flight DM request', async () => {
    const controller = new AbortController();
    const cancelled = new Error('delivery cancelled');
    mocks.request.mockImplementation(({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));

    const delivery = sendUserMessage(
      'app',
      'ou_owner',
      '{"schema":"2.0"}',
      'interactive',
      'stable-uuid',
      { timeoutMs: 1_234, signal: controller.signal },
    );
    controller.abort(cancelled);
    await expect(delivery).rejects.toBe(cancelled);
  });

  it('passes timeout and AbortSignal through message lookup', async () => {
    const controller = new AbortController();
    mocks.request.mockResolvedValue({
      code: 0,
      data: { items: [{ chat_id: 'oc_private' }] },
    });

    await expect(getMessageChatId('app', 'om_card', {
      timeoutMs: 900,
      signal: controller.signal,
    })).resolves.toBe('oc_private');

    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: '/open-apis/im/v1/messages/om_card',
      timeout: 900,
      signal: controller.signal,
    }));
  });

  it('propagates cancellation instead of hiding it as a missing chat', async () => {
    const controller = new AbortController();
    const cancelled = new Error('cancelled');
    mocks.request.mockImplementation(({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));

    const lookup = getMessageChatId('app', 'om_card', {
      timeoutMs: 900,
      signal: controller.signal,
    });
    controller.abort(cancelled);
    await expect(lookup).rejects.toBe(cancelled);
  });
});
