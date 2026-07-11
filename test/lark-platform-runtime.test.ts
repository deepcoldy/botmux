import { describe, expect, it, vi } from 'vitest';
import type { EventHandlers } from '../src/im/lark/event-dispatcher.js';
import {
  LARK_PLATFORM_CAPABILITIES,
  LarkPlatformInstanceMismatchError,
  LarkPlatformRuntime,
  type LarkPlatformRuntimeDeps,
} from '../src/im/lark/runtime.js';
import { requirePlatformPort } from '../src/im/ports.js';
import type {
  PlatformConversationRef,
  PlatformMessageRef,
} from '../src/im/platform.js';

const handlers: EventHandlers = {
  handleCardAction: vi.fn(async () => ({})),
  handleNewTopic: vi.fn(async () => {}),
  handleThreadReply: vi.fn(async () => {}),
};

const dispatcher = { kind: 'fake-ws' } as any;

function makeDeps(overrides: Partial<LarkPlatformRuntimeDeps> = {}): LarkPlatformRuntimeDeps {
  return {
    startEventDispatcher: vi.fn(() => dispatcher) as any,
    stopEventDispatcher: vi.fn() as any,
    sendMessage: vi.fn(async () => 'om_sent') as any,
    replyMessage: vi.fn(async () => 'om_reply') as any,
    sendUserMessage: vi.fn(async () => 'om_dm') as any,
    updateMessage: vi.fn(async () => {}) as any,
    addReaction: vi.fn(async () => 'reaction-id') as any,
    removeReaction: vi.fn(async () => {}) as any,
    downloadMessageResource: vi.fn(async () => {}) as any,
    resolveSender: vi.fn(async (_appId, id, type, hint) => ({
      openId: id,
      type: type === 'bot' ? 'bot' : 'user',
      name: hint?.name,
    })) as any,
    learnFromMentions: vi.fn() as any,
    decideRouting: vi.fn(async (_appId, message) => ({
      scope: 'chat',
      anchor: message.chat_id,
    })) as any,
    ...overrides,
  };
}

function makeRuntime(deps = makeDeps()): LarkPlatformRuntime {
  return new LarkPlatformRuntime({
    larkAppId: 'cli_app_a',
    larkAppSecret: 'secret-a',
    brand: 'lark',
    eventHandlers: handlers,
    deps,
  });
}

function conversation(runtime: LarkPlatformRuntime): PlatformConversationRef {
  return {
    instance: runtime.instance,
    chatId: 'oc_chat',
    conversationType: 'group',
    scope: 'thread',
    anchorId: 'om_root',
    threadId: 'omt_thread',
  };
}

function message(runtime: LarkPlatformRuntime): PlatformMessageRef {
  return {
    instance: runtime.instance,
    messageId: 'om_target',
    conversation: conversation(runtime),
  };
}

describe('LarkPlatformRuntime lifecycle and capabilities', () => {
  it('binds one Lark instance, exposes every real port, and keeps advanced handlers explicit', () => {
    const runtime = makeRuntime();

    expect(runtime.instance).toEqual({ platform: 'lark', instanceId: 'cli_app_a' });
    expect(runtime.capabilities).toBe(LARK_PLATFORM_CAPABILITIES);
    expect(Object.values(runtime.capabilities).every(Boolean)).toBe(true);
    for (const port of ['messaging', 'directMessages', 'cards', 'reactions', 'attachments', 'identity', 'conversation'] as const) {
      expect(requirePlatformPort(runtime, port)).toBe(runtime[port]);
    }
    expect(runtime.extensions.lark).toEqual({ eventHandlers: handlers, brand: 'lark' });
  });

  it('starts/stops idempotently and serializes lifecycle calls in order', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      startEventDispatcher: vi.fn(() => { order.push('start'); return dispatcher; }) as any,
      stopEventDispatcher: vi.fn(() => { order.push('stop'); }) as any,
    });
    const runtime = makeRuntime(deps);

    await Promise.all([runtime.start(), runtime.start()]);
    expect(runtime.isRunning).toBe(true);
    expect(deps.startEventDispatcher).toHaveBeenCalledTimes(1);
    expect(deps.startEventDispatcher).toHaveBeenCalledWith(
      'cli_app_a', 'secret-a', handlers, 'lark',
    );

    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(runtime.isRunning).toBe(false);
    expect(deps.stopEventDispatcher).toHaveBeenCalledTimes(1);
    expect(deps.stopEventDispatcher).toHaveBeenCalledWith(dispatcher);

    await runtime.start();
    expect(order).toEqual(['start', 'stop', 'start']);
  });

  it('preserves lifecycle error identity and remains retryable', async () => {
    const startError = new Error('start failed');
    const stopError = new Error('stop failed');
    const deps = makeDeps({
      startEventDispatcher: vi.fn()
        .mockImplementationOnce(() => { throw startError; })
        .mockReturnValue(dispatcher) as any,
      stopEventDispatcher: vi.fn()
        .mockImplementationOnce(() => { throw stopError; })
        .mockReturnValue(undefined) as any,
    });
    const runtime = makeRuntime(deps);

    expect(await runtime.start().catch(error => error)).toBe(startError);
    await runtime.start();
    expect(await runtime.stop().catch(error => error)).toBe(stopError);
    expect(runtime.isRunning).toBe(true);
    await runtime.stop();
    expect(runtime.isRunning).toBe(false);
  });
});

describe('LarkPlatformRuntime port compatibility', () => {
  it('delegates text send/reply/DM with the original parameter order and maps message refs', async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      sendMessage: vi.fn(async () => { calls.push('send'); return 'om_sent'; }) as any,
      replyMessage: vi.fn(async () => { calls.push('reply'); return 'om_reply'; }) as any,
      sendUserMessage: vi.fn(async () => { calls.push('dm'); return 'om_dm'; }) as any,
    });
    const runtime = makeRuntime(deps);
    const conv = conversation(runtime);
    const target = message(runtime);
    const context = { sessionId: 'session-a' };

    await expect(runtime.sendMessage(conv, 'hello', {
      idempotencyKey: 'uuid-send', context,
    })).resolves.toEqual({ instance: runtime.instance, messageId: 'om_sent', conversation: conv });
    await expect(runtime.replyMessage(target, 'world', {
      inThread: true, idempotencyKey: 'uuid-reply', context,
    })).resolves.toEqual({ instance: runtime.instance, messageId: 'om_reply', conversation: conv });
    await expect(runtime.sendDirectMessage('ou_user', 'private')).resolves.toEqual({
      instance: runtime.instance, messageId: 'om_dm',
    });

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'cli_app_a', 'oc_chat', 'hello', 'text', 'uuid-send', context,
    );
    expect(deps.replyMessage).toHaveBeenCalledWith(
      'cli_app_a', 'om_target', 'world', 'text', true, 'uuid-reply', context,
    );
    expect(deps.sendUserMessage).toHaveBeenCalledWith(
      'cli_app_a', 'ou_user', 'private', 'text',
    );
    expect(calls).toEqual(['send', 'reply', 'dm']);
  });

  it('serializes cards in the adapter and delegates send/reply/update unchanged', async () => {
    const deps = makeDeps();
    const runtime = makeRuntime(deps);
    const conv = conversation(runtime);
    const target = message(runtime);
    const objectCard = { payload: { schema: '2.0', body: { elements: [] } } };
    const rawCard = { payload: '{"schema":"2.0","body":{}}' };

    await expect(runtime.sendCard(conv, objectCard, { idempotencyKey: 'card-send' }))
      .resolves.toMatchObject({ messageId: 'om_sent', conversation: conv });
    await expect(runtime.replyCard(target, rawCard, { inThread: true }))
      .resolves.toMatchObject({ messageId: 'om_reply', conversation: conv });
    await runtime.updateCard(target, objectCard);

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'cli_app_a',
      'oc_chat',
      JSON.stringify(objectCard.payload),
      'interactive',
      'card-send',
      undefined,
    );
    expect(deps.replyMessage).toHaveBeenCalledWith(
      'cli_app_a', 'om_target', rawCard.payload, 'interactive', true, undefined, undefined,
    );
    expect(deps.updateMessage).toHaveBeenCalledWith(
      'cli_app_a', 'om_target', JSON.stringify(objectCard.payload),
    );
  });

  it('delegates reactions and attachment download with exact identifiers', async () => {
    const deps = makeDeps();
    const runtime = makeRuntime(deps);
    const target = message(runtime);

    await expect(runtime.addReaction(target, 'DONE')).resolves.toBe('reaction-id');
    await runtime.removeReaction(target, 'reaction-id');
    await expect(runtime.downloadAttachment({
      sourceMessage: target,
      resourceId: 'file-key',
      type: 'file',
      name: 'report.pdf',
    }, '/tmp/report.pdf')).resolves.toEqual({
      type: 'file', path: '/tmp/report.pdf', name: 'report.pdf',
    });

    expect(deps.addReaction).toHaveBeenCalledWith('cli_app_a', 'om_target', 'DONE');
    expect(deps.removeReaction).toHaveBeenCalledWith('cli_app_a', 'om_target', 'reaction-id');
    expect(deps.downloadMessageResource).toHaveBeenCalledWith(
      'cli_app_a', 'om_target', 'file-key', 'file', '/tmp/report.pdf',
    );
  });

  it('maps neutral identity/mentions and full conversation routing at the Lark boundary', async () => {
    const deps = makeDeps({
      resolveSender: vi.fn(async () => ({ openId: 'ou_bot', type: 'bot', name: 'Builder' })) as any,
      decideRouting: vi.fn()
        .mockResolvedValueOnce({ scope: 'thread', anchor: 'om_root' })
        .mockResolvedValueOnce({ scope: 'chat', anchor: 'oc_dm' }) as any,
    });
    const runtime = makeRuntime(deps);

    await expect(runtime.resolveSender('ou_bot', 'bot', { name: 'hint' })).resolves.toEqual({
      id: 'ou_bot', type: 'bot', name: 'Builder',
    });
    runtime.learnMentions([
      { token: '@_user_1', name: 'Alice', identity: { id: 'ou_alice' } },
      { token: '@_user_2', name: 'Bob', identity: { id: 'on_bob', idType: 'union_id' } },
      { token: '@_all', name: 'all' },
    ]);
    await expect(runtime.resolveInitialConversation({
      instance: runtime.instance,
      chatId: 'oc_topic',
      messageId: 'om_reply',
      conversationType: 'group',
      rootMessageId: 'om_root',
      threadId: 'omt_thread',
    })).resolves.toEqual({
      instance: runtime.instance,
      chatId: 'oc_topic',
      conversationType: 'group',
      scope: 'thread',
      anchorId: 'om_root',
      threadRootId: 'om_root',
      threadId: 'omt_thread',
    });
    await expect(runtime.resolveInitialConversation({
      instance: runtime.instance,
      chatId: 'oc_dm',
      messageId: 'om_dm',
      conversationType: 'direct',
    })).resolves.toMatchObject({ scope: 'chat', anchorId: 'oc_dm' });

    expect(deps.resolveSender).toHaveBeenCalledWith(
      'cli_app_a', 'ou_bot', 'bot', { type: 'bot', name: 'hint' },
    );
    expect(deps.learnFromMentions).toHaveBeenCalledWith('cli_app_a', [
      { name: 'Alice', openId: 'ou_alice' },
      { name: 'Bob', openId: undefined },
      { name: 'all', openId: undefined },
    ]);
    expect(deps.decideRouting).toHaveBeenNthCalledWith(
      1, 'cli_app_a', {
        message_id: 'om_reply', chat_id: 'oc_topic', chat_type: 'group',
        root_id: 'om_root', thread_id: 'omt_thread',
      },
    );
    expect(deps.decideRouting).toHaveBeenNthCalledWith(
      2, 'cli_app_a', {
        message_id: 'om_dm', chat_id: 'oc_dm', chat_type: 'p2p',
        root_id: undefined, thread_id: undefined,
      },
    );
  });

  it('rejects empty sender identities instead of fabricating an unusable sender', async () => {
    const runtime = makeRuntime();
    await expect(runtime.resolveSender('  ', 'user')).rejects.toThrow(TypeError);
  });

  it('propagates the exact dependency error object', async () => {
    const failure = new Error('lark send failed');
    const deps = makeDeps({ sendMessage: vi.fn(async () => { throw failure; }) as any });
    const runtime = makeRuntime(deps);

    const caught = await runtime.sendMessage(conversation(runtime), 'hello').catch(error => error);
    expect(caught).toBe(failure);
  });

  it('rejects a conversation or message owned by another platform instance', async () => {
    const runtime = makeRuntime();
    const foreign = {
      ...conversation(runtime),
      instance: { platform: 'lark' as const, instanceId: 'cli_app_b' },
    };

    await expect(runtime.sendMessage(foreign, 'hello')).rejects.toBeInstanceOf(
      LarkPlatformInstanceMismatchError,
    );
  });
});
