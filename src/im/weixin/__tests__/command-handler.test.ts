import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isCommand, handleCommand } from '../command-handler.js';
import type { WeixinCommandContext } from '../command-handler.js';
import type { ImMessage } from '../../types.js';

function makeMsg(content: string): ImMessage {
  return {
    id: 'msg-1',
    threadId: 'user-1',
    senderId: 'user-1',
    senderType: 'user',
    content,
    msgType: 'text',
    createTime: new Date().toISOString(),
  };
}

function makeCtx(overrides: Partial<WeixinCommandContext> = {}): WeixinCommandContext {
  return {
    sendReply: vi.fn(async () => {}),
    handler: {
      onNewTopic: vi.fn(async () => {}),
      onThreadReply: vi.fn(async () => {}),
      onCardAction: vi.fn(async () => {}),
    },
    getActiveSessionKey: vi.fn(() => undefined),
    clearSession: vi.fn(),
    ...overrides,
  };
}

describe('isCommand', () => {
  it('returns true for /help', () => {
    expect(isCommand('/help')).toBe(true);
  });

  it('returns true for /new', () => {
    expect(isCommand('/new')).toBe(true);
  });

  it('returns true for /close', () => {
    expect(isCommand('/close')).toBe(true);
  });

  it('returns true for unknown /commands', () => {
    expect(isCommand('/unknown')).toBe(true);
  });

  it('returns false for regular text', () => {
    expect(isCommand('hello')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isCommand('')).toBe(false);
  });
});

describe('handleCommand', () => {
  let ctx: WeixinCommandContext;

  beforeEach(() => {
    ctx = makeCtx();
  });

  describe('/help', () => {
    it('sends help text via sendReply', async () => {
      await handleCommand(makeMsg('/help'), ctx);
      expect(ctx.sendReply).toHaveBeenCalledWith(
        'user-1',
        expect.stringContaining('/new'),
      );
      expect(ctx.sendReply).toHaveBeenCalledWith(
        'user-1',
        expect.stringContaining('/help'),
      );
    });
  });

  describe('/new', () => {
    it('clears session and calls handler.onNewTopic', async () => {
      await handleCommand(makeMsg('/new'), ctx);
      expect(ctx.clearSession).toHaveBeenCalledWith('user-1');
      expect(ctx.handler.onNewTopic).toHaveBeenCalledWith(
        expect.objectContaining({ content: '' }),
        'weixin',
        'p2p',
      );
    });

    it('passes prompt text to onNewTopic when provided', async () => {
      await handleCommand(makeMsg('/new fix the bug please'), ctx);
      expect(ctx.clearSession).toHaveBeenCalledWith('user-1');
      expect(ctx.handler.onNewTopic).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'fix the bug please' }),
        'weixin',
        'p2p',
      );
    });
  });

  describe('/restart', () => {
    it('calls onCardAction restart when active session exists', async () => {
      ctx = makeCtx({ getActiveSessionKey: vi.fn(() => 'session-key-1') });
      await handleCommand(makeMsg('/restart'), ctx);
      expect(ctx.handler.onCardAction).toHaveBeenCalledWith({
        actionType: 'restart',
        threadId: 'session-key-1',
      });
    });

    it('sends "no active session" message when no session', async () => {
      await handleCommand(makeMsg('/restart'), ctx);
      expect(ctx.sendReply).toHaveBeenCalledWith(
        'user-1',
        expect.stringContaining('没有活跃'),
      );
    });
  });

  describe('/close', () => {
    it('clears session and sends confirmation', async () => {
      await handleCommand(makeMsg('/close'), ctx);
      expect(ctx.clearSession).toHaveBeenCalledWith('user-1');
      expect(ctx.sendReply).toHaveBeenCalledWith(
        'user-1',
        expect.stringContaining('已关闭'),
      );
    });
  });

  describe('/switch', () => {
    it('sends "in development" message', async () => {
      await handleCommand(makeMsg('/switch codex'), ctx);
      expect(ctx.sendReply).toHaveBeenCalledWith(
        'user-1',
        expect.stringContaining('开发中'),
      );
    });
  });

  describe('unknown command', () => {
    it('sends error message with the unknown command', async () => {
      await handleCommand(makeMsg('/foobar'), ctx);
      expect(ctx.sendReply).toHaveBeenCalledWith(
        'user-1',
        expect.stringContaining('/foobar'),
      );
    });
  });
});
