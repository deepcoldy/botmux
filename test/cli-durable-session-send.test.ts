import { describe, expect, it, vi } from 'vitest';
import { dispatchDurableSessionMessage, durablePrimaryFinalProviderUuid } from '../src/cli/durable-session-send.js';

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
  it('derives final provider identity from the logical conversation rather than local Session UUID', () => {
    const common = {
      larkAppId: 'cli_test',
      scope: 'thread' as const,
      anchor: 'om_root',
      turnId: 'om_turn',
    };
    expect(durablePrimaryFinalProviderUuid(common)).toBe(
      durablePrimaryFinalProviderUuid({ ...common }),
    );
    expect(durablePrimaryFinalProviderUuid(common)).not.toBe(
      durablePrimaryFinalProviderUuid({ ...common, anchor: 'om_other' }),
    );
    expect(durablePrimaryFinalProviderUuid(common)).toMatch(/^dps_[a-f0-9]{32}$/);
  });

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

  it('retries a lost daemon response with the same turn and provider identity', async () => {
    const post = vi.fn()
      .mockRejectedValueOnce(new Error('socket closed during daemon restart'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        kind: 'delivered',
        messageId: 'om_reconciled',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const wait = vi.fn(async () => {});

    await expect(dispatchDurableSessionMessage({ post, sleep: wait }, input))
      .resolves.toBe('om_reconciled');
    expect(wait).toHaveBeenCalledExactlyOnceWith(1_000);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]).toEqual(post.mock.calls[0]);
    expect(post.mock.calls[1][2]).toMatchObject({
      turnId: 'om_turn',
      providerUuid: 'bts_123',
    });
  });

  it('retries a startup-unavailable daemon response but stops on a durable ambiguity', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false, error: 'sessions are still restoring',
      }), { status: 503, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false, kind: 'ambiguous', error: 'provider outcome unknown',
      }), { status: 409, headers: { 'content-type': 'application/json' } }));
    const wait = vi.fn(async () => {});

    await expect(dispatchDurableSessionMessage({ post, sleep: wait }, input))
      .rejects.toThrow('durable Session send is ambiguous: provider outcome unknown');
    expect(post).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledExactlyOnceWith(1_000);
  });

  it('surfaces ambiguous settlement and never invents a fallback message id', async () => {
    const post = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      kind: 'ambiguous',
      error: 'provider outcome unknown',
    }), { status: 409, headers: { 'content-type': 'application/json' } }));

    await expect(dispatchDurableSessionMessage({ post }, input))
      .rejects.toThrow('durable Session send is ambiguous: provider outcome unknown');
    expect(post).toHaveBeenCalledOnce();
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
