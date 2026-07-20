import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForwardFollowupBuffer } from '../src/im/lark/forward-followup-buffer.js';

describe('ForwardFollowupBuffer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('takes a root-linked seed from the same app, chat, and sender', () => {
    const flush = vi.fn();
    const buffer = new ForwardFollowupBuffer<string>(1_500);
    buffer.hold({
      larkAppId: 'app-1',
      chatId: 'chat-1',
      senderOpenId: 'user-1',
      messageId: 'seed-1',
      payload: 'forwarded content',
      flush,
    });

    const seed = buffer.take({
      larkAppId: 'app-1',
      chatId: 'chat-1',
      senderOpenId: 'user-1',
      rootId: 'seed-1',
    });

    expect(seed?.payload).toBe('forwarded content');
    expect(buffer.size).toBe(0);
    vi.advanceTimersByTime(1_500);
    expect(flush).not.toHaveBeenCalled();
  });

  it('does not consume a seed for a different app, chat, or sender', () => {
    const buffer = new ForwardFollowupBuffer<string>(1_500);
    buffer.hold({
      larkAppId: 'app-1',
      chatId: 'chat-1',
      senderOpenId: 'user-1',
      messageId: 'seed-1',
      payload: 'forwarded content',
      flush: vi.fn(),
    });

    expect(buffer.take({ larkAppId: 'app-2', chatId: 'chat-1', senderOpenId: 'user-1', rootId: 'seed-1' })).toBeUndefined();
    expect(buffer.take({ larkAppId: 'app-1', chatId: 'chat-2', senderOpenId: 'user-1', rootId: 'seed-1' })).toBeUndefined();
    expect(buffer.take({ larkAppId: 'app-1', chatId: 'chat-1', senderOpenId: 'user-2', rootId: 'seed-1' })).toBeUndefined();
    expect(buffer.size).toBe(1);
  });

  it('flushes an unmatched seed exactly once after the grace period', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const buffer = new ForwardFollowupBuffer<string>(1_500);
    buffer.hold({
      larkAppId: 'app-1',
      chatId: 'chat-1',
      senderOpenId: 'user-1',
      messageId: 'seed-1',
      payload: 'forwarded content',
      flush,
    });

    await vi.advanceTimersByTimeAsync(1_499);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith('forwarded content');
    expect(buffer.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(flush).toHaveBeenCalledOnce();
  });

  it('does not hold when the grace period is disabled', () => {
    const buffer = new ForwardFollowupBuffer<string>(0);
    expect(buffer.hold({
      larkAppId: 'app-1',
      chatId: 'chat-1',
      senderOpenId: 'user-1',
      messageId: 'seed-1',
      payload: 'forwarded content',
      flush: vi.fn(),
    })).toBe(false);
    expect(buffer.size).toBe(0);
  });

  it('accepts a remaining wait override when restoring persisted seeds', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const buffer = new ForwardFollowupBuffer<string>(1_500);
    buffer.hold({
      larkAppId: 'app-1',
      chatId: 'chat-1',
      senderOpenId: 'user-1',
      messageId: 'seed-restored',
      payload: 'restored',
      flush,
    }, 25);

    await vi.advanceTimersByTimeAsync(24);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledOnce();
  });
});
