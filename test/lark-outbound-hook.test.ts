import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  reply: vi.fn(),
  emitHookEvent: vi.fn(),
  evaluatePromptGate: vi.fn(),
  hasSyncGateHooks: vi.fn(),
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
  evaluatePromptGate: mocks.evaluatePromptGate,
  hasSyncGateHooks: mocks.hasSyncGateHooks,
}));

import { OutboundBlockedError, replyMessage, sendMessage } from '../src/im/lark/client.js';

describe('Lark outbound hook provider replay suppression', () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_send' } });
    mocks.reply.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_reply' } });
    mocks.emitHookEvent.mockReset();
    // Default: no pre_send gate configured → allow (the real evaluatePromptGate
    // returns allow without spawning when nothing matches).
    mocks.evaluatePromptGate.mockReset().mockResolvedValue({ allowed: true });
    // 默认「已配置 sync 闸」，让用例真的走到 evaluatePromptGate；
    // 「没配闸」的零开销快路径由专门的用例覆盖。
    mocks.hasSyncGateHooks.mockReset().mockReturnValue(true);
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

describe('outbound.pre_send sync gate', () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_send' } });
    mocks.reply.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_reply' } });
    mocks.emitHookEvent.mockReset();
    mocks.evaluatePromptGate.mockReset().mockResolvedValue({ allowed: true });
    // 默认「已配置 sync 闸」，让用例真的走到 evaluatePromptGate；
    // 「没配闸」的零开销快路径由专门的用例覆盖。
    mocks.hasSyncGateHooks.mockReset().mockReturnValue(true);
  });

  it('a deny means the message NEVER reaches Lark', async () => {
    // The whole point of pre_send vs outbound.send: this one can actually stop
    // the send. If the API mock was called, the gate is decorative.
    mocks.evaluatePromptGate.mockResolvedValue({ allowed: false, reason: 'contains a secret' });

    await expect(sendMessage('app', 'oc_chat', 'AKIA-leaked-key', 'text'))
      .rejects.toBeInstanceOf(OutboundBlockedError);

    expect(mocks.create).not.toHaveBeenCalled();
    // And no post-send hook either — nothing was sent, so nothing to report.
    expect(mocks.emitHookEvent).not.toHaveBeenCalled();
  });

  it('surfaces the hook reason on the thrown error', async () => {
    mocks.evaluatePromptGate.mockResolvedValue({ allowed: false, reason: 'contains a secret' });
    await expect(sendMessage('app', 'oc_chat', 'x', 'text'))
      .rejects.toMatchObject({ blockedReason: 'contains a secret' });
  });

  it('blocks replies too, before the reply API call', async () => {
    mocks.evaluatePromptGate.mockResolvedValue({ allowed: false });
    await expect(replyMessage('app', 'om_parent', 'nope', 'text', true))
      .rejects.toBeInstanceOf(OutboundBlockedError);
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it('allows normally when the gate allows, and still fires the post-send hook', async () => {
    await expect(sendMessage('app', 'oc_chat', 'fine', 'text', 'u1', { sessionId: 'sid' }))
      .resolves.toBe('om_send');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.emitHookEvent).toHaveBeenCalledWith('outbound.send', expect.anything());
  });

  it('asks the gate BEFORE the API call, with the outgoing content', async () => {
    await sendMessage('app', 'oc_chat', 'hello there', 'text', 'u2');
    expect(mocks.evaluatePromptGate).toHaveBeenCalledWith('outbound.pre_send', expect.objectContaining({
      surface: 'sendMessage',
      chatId: 'oc_chat',
      content: 'hello there',
      larkAppId: 'app',
    }));
  });

  it('reaches the Lark API in the same microtask turn as before the gate existed', async () => {
    // Regression: the first version awaited assertOutboundAllowed
    // unconditionally, inserting a microtask BEFORE the Lark API call. That is
    // observable to fire-and-forget callers (`void sendUserMessage(...)` in
    // notifyVcMeetingInviteFailure) and to tests asserting right after them —
    // it broke 4 unrelated VC tests. With no gate configured this feature must
    // be invisible, call ordering included.
    //
    // Probe: let exactly the pre-existing number of microtasks drain, then
    // check the API was reached. An extra `await` in the path pushes it past
    // this point and the assertion fails (verified against the buggy version).
    mocks.hasSyncGateHooks.mockReturnValue(false);

    void sendMessage('app', 'oc_chat', 'timing', 'text');
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.evaluatePromptGate).not.toHaveBeenCalled();
  });

  it('honours suppressHook so internal re-renders are not adjudicated', async () => {
    mocks.evaluatePromptGate.mockResolvedValue({ allowed: false });
    await expect(sendMessage('app', 'oc_chat', 'internal', 'text', 'u3', undefined, { suppressHook: true }))
      .resolves.toBe('om_send');
    expect(mocks.evaluatePromptGate).not.toHaveBeenCalled();
  });
});
