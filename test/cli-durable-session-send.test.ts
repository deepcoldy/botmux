import { describe, expect, it, vi } from 'vitest';
import { dispatchDurableSessionMessage } from '../src/cli/durable-session-send.js';

const input = {
  sessionId: 'session-1',
  turnId: 'om_turn',
  target: { kind: 'reply' as const, messageId: 'om_root', replyInThread: true },
  content: '{"schema":"2.0"}',
  msgType: 'interactive',
  providerUuid: 'bts_123',
  hookContext: { sessionId: 'session-1' },
};

describe('durable Session send client', () => {
  it('returns the daemon-settled provider message id', async () => {
    const post = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      kind: 'delivered',
      messageId: 'om_delivered',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(dispatchDurableSessionMessage({ post }, input)).resolves.toBe('om_delivered');
    expect(post).toHaveBeenCalledWith('session-1', 'durable-send', {
      turnId: 'om_turn',
      target: input.target,
      content: input.content,
      msgType: 'interactive',
      providerUuid: 'bts_123',
      hookContext: { sessionId: 'session-1' },
    });
  });

  it('surfaces ambiguous settlement and never invents a fallback message id', async () => {
    const post = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      kind: 'ambiguous',
      error: 'provider outcome unknown',
    }), { status: 409, headers: { 'content-type': 'application/json' } }));

    await expect(dispatchDurableSessionMessage({ post }, input))
      .rejects.toThrow('durable Session send is ambiguous: provider outcome unknown');
  });

  it('rejects malformed success responses', async () => {
    const post = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      kind: 'delivered',
      messageId: 'not-a-lark-message',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(dispatchDurableSessionMessage({ post }, input))
      .rejects.toThrow('durable Session send failed: HTTP 200');
  });
});
