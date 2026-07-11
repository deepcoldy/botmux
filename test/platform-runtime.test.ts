import { describe, expect, it, vi } from 'vitest';
import {
  CrossPlatformOperationError,
  PlatformCapabilityUnavailableError,
  conversationRoutingAnchor,
  createPlatformCapabilities,
  derivePlatformInstanceIdentity,
  platformInstanceKey,
  requirePlatformCapability,
  requireSamePlatform,
  samePlatform,
  samePlatformInstance,
  type PlatformAttachment,
  type PlatformConversationRef,
  type PlatformInstanceRef,
  type PlatformMention,
  type PlatformSender,
} from '../src/im/platform.js';
import {
  PlatformPortUnavailableError,
  requirePlatformPort,
  type PlatformMessagingPort,
  type PlatformRuntime,
} from '../src/im/ports.js';
import { stopPlatformRuntimeWithRetry } from '../src/im/runtime-lifecycle.js';

const larkA: PlatformInstanceRef = { platform: 'lark', instanceId: 'cli_app_a' };
const larkB: PlatformInstanceRef = { platform: 'lark', instanceId: 'cli_app_b' };

describe('platform models', () => {
  it('keeps platform-instance identity separate from platform identity', () => {
    expect(platformInstanceKey(larkA)).toBe('["lark","cli_app_a"]');
    expect(samePlatform(larkA, larkB)).toBe(true);
    expect(samePlatformInstance(larkA, larkB)).toBe(false);
    expect(samePlatformInstance(larkA, { ...larkA })).toBe(true);
  });

  it('normalizes identity without combining future platforms with legacy Lark ids', () => {
    expect(derivePlatformInstanceIdentity({ platform: ' lark ', instanceId: ' app-a ', larkAppId: 'app-a' }))
      .toEqual({ platform: 'lark', instanceId: 'app-a' });
    expect(derivePlatformInstanceIdentity({ platform: 'discord', larkAppId: 'legacy' }, 'fallback'))
      .toBeNull();
    expect(derivePlatformInstanceIdentity({ platform: 'lark', instanceId: 'a', larkAppId: 'b' }))
      .toBeNull();
  });

  it('represents attachment, mention, and sender identities without Lark field names', () => {
    const attachment: PlatformAttachment = { type: 'image', path: '/tmp/a.png', name: 'a.png' };
    const mention: PlatformMention = {
      token: '@_user_1',
      name: 'Alice',
      identity: { id: 'primary', secondaryId: 'secondary', stableId: 'stable', idType: 'opaque' },
    };
    const sender: PlatformSender = { id: 'primary', type: 'user', name: 'Alice' };

    expect(attachment).toEqual({ type: 'image', path: '/tmp/a.png', name: 'a.png' });
    expect(mention.identity).toEqual({
      id: 'primary', secondaryId: 'secondary', stableId: 'stable', idType: 'opaque',
    });
    expect(sender).toEqual({ id: 'primary', type: 'user', name: 'Alice' });
  });

  it('uses the adapter-computed routing anchor for chat and thread conversations', () => {
    const chat: PlatformConversationRef = {
      instance: larkA,
      chatId: 'chat-a',
      conversationType: 'group',
      scope: 'chat',
      anchorId: 'chat-a',
    };
    const thread: PlatformConversationRef = {
      instance: larkA,
      chatId: 'chat-a',
      conversationType: 'group',
      scope: 'thread',
      anchorId: 'message-root',
      threadId: 'thread-a',
    };

    expect(conversationRoutingAnchor(chat)).toBe('chat-a');
    expect(conversationRoutingAnchor(thread)).toBe('message-root');
  });
});

describe('platform capabilities and ports', () => {
  it('fills every undeclared capability with false and requires supported ones explicitly', () => {
    const provider = {
      instance: larkA,
      capabilities: createPlatformCapabilities({ messaging: true, threads: true }),
    };

    expect(provider.capabilities.messaging).toBe(true);
    expect(provider.capabilities.threads).toBe(true);
    expect(provider.capabilities.cards).toBe(false);
    expect(() => requirePlatformCapability(provider, 'threads')).not.toThrow();
    expect(() => requirePlatformCapability(provider, 'cards')).toThrowError(
      PlatformCapabilityUnavailableError,
    );

    try {
      requirePlatformCapability(provider, 'cards');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'platform_capability_unavailable',
        capability: 'cards',
        instance: larkA,
      });
    }
  });

  it('returns present ports and distinguishes missing capability from a broken runtime declaration', () => {
    const messaging: PlatformMessagingPort = {
      sendMessage: vi.fn(),
      replyMessage: vi.fn(),
    };
    const runtime: PlatformRuntime = {
      instance: larkA,
      capabilities: createPlatformCapabilities({ messaging: true, reactions: true }),
      messaging,
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };

    expect(requirePlatformPort(runtime, 'messaging')).toBe(messaging);
    expect(() => requirePlatformPort(runtime, 'cards')).toThrowError(
      PlatformCapabilityUnavailableError,
    );
    expect(() => requirePlatformPort(runtime, 'reactions')).toThrowError(
      PlatformPortUnavailableError,
    );
  });

  it('exposes an explicit start/stop lifecycle', async () => {
    let running = false;
    const runtime: PlatformRuntime = {
      instance: larkA,
      capabilities: createPlatformCapabilities(),
      async start() { running = true; },
      async stop() { running = false; },
    };

    await runtime.start();
    expect(running).toBe(true);
    await runtime.stop();
    expect(running).toBe(false);
  });

  it('retries a failed runtime stop without dropping the original failure', async () => {
    const firstError = new Error('socket close failed');
    const stop = vi.fn()
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce(undefined);
    const onFailure = vi.fn();
    const runtime: PlatformRuntime = {
      instance: larkA,
      capabilities: createPlatformCapabilities(),
      start: vi.fn(async () => {}),
      stop,
    };

    await expect(stopPlatformRuntimeWithRetry(runtime, 2, onFailure)).resolves.toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledWith(firstError, 1, 2);
  });

  it('reports false only after every bounded stop attempt fails', async () => {
    const stop = vi.fn(async () => { throw new Error('still open'); });
    const onFailure = vi.fn();
    const runtime: PlatformRuntime = {
      instance: larkA,
      capabilities: createPlatformCapabilities(),
      start: vi.fn(async () => {}),
      stop,
    };

    await expect(stopPlatformRuntimeWithRetry(runtime, 2, onFailure)).resolves.toBe(false);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledTimes(2);
  });
});

describe('same-platform guard', () => {
  it('allows different instances of one platform', () => {
    expect(() => requireSamePlatform(larkA, larkB)).not.toThrow();
  });

  it('rejects cross-platform routing with a structured error', () => {
    const futureDiscord = { platform: 'discord', instanceId: 'discord-a' };
    expect(samePlatform(larkA, futureDiscord)).toBe(false);
    expect(() => requireSamePlatform(larkA, futureDiscord)).toThrowError(CrossPlatformOperationError);

    try {
      requireSamePlatform(larkA, futureDiscord);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'unsupported_cross_platform',
        sourcePlatform: 'lark',
        targetPlatform: 'discord',
      });
    }
  });
});
