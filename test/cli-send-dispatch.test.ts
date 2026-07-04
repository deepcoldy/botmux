import { describe, expect, it, vi } from 'vitest';

import { dispatchPrimaryMessage, findStdinAliasAttachment, sendFileAttachments } from '../src/cli/send-dispatch.js';

class MessageWithdrawnError extends Error {}

describe('dispatchPrimaryMessage hook context wiring', () => {
  const baseOptions = {
    appId: 'cli_app',
    targetChatId: 'oc_chat',
    hookContext: {
      sessionId: 'sid_1',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 'Hook Context',
    },
    MessageWithdrawnError,
  };

  it('passes hookContext when quote reply succeeds', async () => {
    const replyMessage = vi.fn(async () => 'om_reply');
    const sendMessage = vi.fn(async () => 'om_send');

    const result = await dispatchPrimaryMessage(
      { replyMessage, sendMessage },
      {
        ...baseOptions,
        quoteTargetId: 'om_quote',
        dispatch: vi.fn(async () => 'om_dispatch'),
        content: '{"schema":"2.0"}',
        msgType: 'interactive',
      },
    );

    expect(result).toEqual({ messageId: 'om_reply', primaryQuotedId: 'om_quote' });
    expect(replyMessage).toHaveBeenCalledWith(
      'cli_app',
      'om_quote',
      '{"schema":"2.0"}',
      'interactive',
      false,
      undefined,
      baseOptions.hookContext,
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('passes hookContext when withdrawn quote falls back to plain send', async () => {
    const replyMessage = vi.fn(async () => {
      throw new MessageWithdrawnError('withdrawn');
    });
    const sendMessage = vi.fn(async () => 'om_send');

    const result = await dispatchPrimaryMessage(
      { replyMessage, sendMessage },
      {
        ...baseOptions,
        quoteTargetId: 'om_quote',
        dispatch: vi.fn(async () => 'om_dispatch'),
        content: '{"zh_cn":{"content":[]}}',
        msgType: 'post',
      },
    );

    expect(result).toEqual({ messageId: 'om_send', primaryQuotedId: null });
    expect(sendMessage).toHaveBeenCalledWith(
      'cli_app',
      'oc_chat',
      '{"zh_cn":{"content":[]}}',
      'post',
      undefined,
      baseOptions.hookContext,
    );
  });
});

describe('findStdinAliasAttachment (reject stdin-as-attachment up front)', () => {
  it('flags every known stdin alias', () => {
    for (const p of ['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']) {
      expect(findStdinAliasAttachment([p])).toBe(p);
    }
  });

  it('tolerates surrounding whitespace', () => {
    expect(findStdinAliasAttachment([' /dev/stdin '])).toBe(' /dev/stdin ');
  });

  it('returns null for ordinary file paths', () => {
    expect(findStdinAliasAttachment(['/tmp/report.md', './chart.png'])).toBeNull();
    expect(findStdinAliasAttachment([])).toBeNull();
  });

  it('returns the first aliasing path when mixed with real ones', () => {
    expect(findStdinAliasAttachment(['/tmp/ok.png', '/dev/stdin', '/tmp/also.md'])).toBe('/dev/stdin');
  });
});

describe('sendFileAttachments (best-effort, never throws after primary send)', () => {
  it('uploads + dispatches each file and returns their message ids', async () => {
    const uploadFile = vi.fn(async (_app: string, p: string) => `key:${p}`);
    const dispatch = vi.fn(async (content: string) => `om:${content}`);

    const res = await sendFileAttachments({ uploadFile, dispatch }, 'cli_app', ['/a', '/b']);

    expect(res.failed).toEqual([]);
    expect(res.sent).toEqual([
      'om:{"file_key":"key:/a"}',
      'om:{"file_key":"key:/b"}',
    ]);
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });

  it('captures a failing attachment without throwing and still sends the others', async () => {
    const uploadFile = vi.fn(async (_app: string, p: string) => {
      if (p === '/bad') throw new Error('upload boom');
      return `key:${p}`;
    });
    const dispatch = vi.fn(async (content: string) => `om:${content}`);

    const res = await sendFileAttachments({ uploadFile, dispatch }, 'cli_app', ['/good', '/bad', '/good2']);

    expect(res.sent).toEqual(['om:{"file_key":"key:/good"}', 'om:{"file_key":"key:/good2"}']);
    expect(res.failed).toEqual([{ path: '/bad', error: 'upload boom' }]);
  });

  it('captures a dispatch failure too, and never rejects even if all fail', async () => {
    const uploadFile = vi.fn(async (_app: string, p: string) => `key:${p}`);
    const dispatch = vi.fn(async () => { throw new Error('dispatch down'); });

    const res = await sendFileAttachments({ uploadFile, dispatch }, 'cli_app', ['/x', '/y']);

    expect(res.sent).toEqual([]);
    expect(res.failed).toEqual([
      { path: '/x', error: 'dispatch down' },
      { path: '/y', error: 'dispatch down' },
    ]);
  });
});
