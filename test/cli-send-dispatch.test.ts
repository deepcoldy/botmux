import { describe, expect, it, vi } from 'vitest';

import {
  dispatchPrimaryMessage,
  findStdinAliasAttachment,
  sendFileAttachments,
  sendVideoAttachments,
  shouldSendAsPureVideo,
  validateVideoAttachments,
} from '../src/cli/send-dispatch.js';

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

describe('shouldSendAsPureVideo', () => {
  const base = { hasBodyText: false, imageCount: 0, fileCount: 0, videoCount: 1, mentionCount: 0 };

  it('is a pure media send only for a bare video with no text/attachments/mentions', () => {
    expect(shouldSendAsPureVideo(base)).toBe(true);
    expect(shouldSendAsPureVideo({ ...base, videoCount: 2 })).toBe(true);
  });

  it('is NOT pure-video when mentions are present (media messages cannot embed <at>)', () => {
    // Regression guard: with a mention the send must go through the card path so
    // the @ actually fires — otherwise the mention silently drops while the
    // success output still reports `mentioned`.
    expect(shouldSendAsPureVideo({ ...base, mentionCount: 1 })).toBe(false);
  });

  it('is NOT pure-video when text/image/file body content coexists', () => {
    expect(shouldSendAsPureVideo({ ...base, hasBodyText: true })).toBe(false);
    expect(shouldSendAsPureVideo({ ...base, imageCount: 1 })).toBe(false);
    expect(shouldSendAsPureVideo({ ...base, fileCount: 1 })).toBe(false);
  });

  it('is NOT pure-video when there is no video at all', () => {
    expect(shouldSendAsPureVideo({ ...base, videoCount: 0 })).toBe(false);
  });
});

describe('validateVideoAttachments', () => {
  it('accepts repeated mp4 videos with matching image covers', () => {
    expect(validateVideoAttachments(['/tmp/a.mp4', '/tmp/b.MP4'], ['/tmp/a.png', '/tmp/b.JPG'])).toEqual({
      ok: true,
      videos: [
        { videoPath: '/tmp/a.mp4', coverPath: '/tmp/a.png', durationMs: 0 },
        { videoPath: '/tmp/b.MP4', coverPath: '/tmp/b.JPG', durationMs: 0 },
      ],
    });
  });

  it('rejects missing or mismatched covers as usage errors', () => {
    expect(validateVideoAttachments(['/tmp/a.mp4'], [])).toEqual({
      ok: false,
      error: '--videos 与 --video-covers 数量必须一致（videos=1, covers=0）',
    });
    expect(validateVideoAttachments([], ['/tmp/a.png'])).toEqual({
      ok: false,
      error: '--video-covers 需要配套 --videos 使用',
    });
  });

  it('rejects unsupported video and cover extensions', () => {
    expect(validateVideoAttachments(['/tmp/a.mov'], ['/tmp/a.png'])).toEqual({
      ok: false,
      error: '不支持的视频格式: /tmp/a.mov（目前仅支持 .mp4）',
    });
    expect(validateVideoAttachments(['/tmp/a.mp4'], ['/tmp/a.svg'])).toEqual({
      ok: false,
      error: '不支持的视频封面格式: /tmp/a.svg（支持 .png/.jpg/.jpeg/.gif/.webp/.bmp）',
    });
  });
});

describe('sendVideoAttachments (best-effort media messages)', () => {
  it('uploads the mp4 and cover, then dispatches Lark media content', async () => {
    const uploadFile = vi.fn(async (_app: string, p: string) => `file:${p}`);
    const uploadImage = vi.fn(async (_app: string, p: string) => `image:${p}`);
    const dispatch = vi.fn(async (content: string, msgType: string) => `om:${msgType}:${content}`);

    const res = await sendVideoAttachments(
      { uploadFile, uploadImage, dispatch },
      'cli_app',
      [{ videoPath: '/tmp/replay.mp4', coverPath: '/tmp/cover.png', durationMs: 0 }],
    );

    expect(res.failed).toEqual([]);
    expect(res.sent).toEqual([
      'om:media:{"file_key":"file:/tmp/replay.mp4","image_key":"image:/tmp/cover.png","duration":0}',
    ]);
    expect(uploadFile).toHaveBeenCalledWith('cli_app', '/tmp/replay.mp4');
    expect(uploadImage).toHaveBeenCalledWith('cli_app', '/tmp/cover.png');
    expect(dispatch).toHaveBeenCalledWith(
      '{"file_key":"file:/tmp/replay.mp4","image_key":"image:/tmp/cover.png","duration":0}',
      'media',
    );
  });

  it('captures a failing video upload without rejecting and still sends later videos', async () => {
    const uploadFile = vi.fn(async (_app: string, p: string) => {
      if (p === '/tmp/bad.mp4') throw new Error('upload failed');
      return `file:${p}`;
    });
    const uploadImage = vi.fn(async (_app: string, p: string) => `image:${p}`);
    const dispatch = vi.fn(async (content: string) => `om:${content}`);

    const res = await sendVideoAttachments(
      { uploadFile, uploadImage, dispatch },
      'cli_app',
      [
        { videoPath: '/tmp/bad.mp4', coverPath: '/tmp/bad.png', durationMs: 0 },
        { videoPath: '/tmp/good.mp4', coverPath: '/tmp/good.png', durationMs: 0 },
      ],
    );

    expect(res.sent).toEqual([
      'om:{"file_key":"file:/tmp/good.mp4","image_key":"image:/tmp/good.png","duration":0}',
    ]);
    expect(res.failed).toEqual([{ path: '/tmp/bad.mp4', coverPath: '/tmp/bad.png', error: 'upload failed' }]);
  });

  it('captures cover upload and dispatch failures without rejecting', async () => {
    const coverUploadFails = await sendVideoAttachments(
      {
        uploadFile: vi.fn(async () => 'file:key'),
        uploadImage: vi.fn(async () => { throw new Error('cover failed'); }),
        dispatch: vi.fn(async () => 'om_media'),
      },
      'cli_app',
      [{ videoPath: '/tmp/a.mp4', coverPath: '/tmp/a.png', durationMs: 0 }],
    );
    expect(coverUploadFails).toEqual({
      sent: [],
      failed: [{ path: '/tmp/a.mp4', coverPath: '/tmp/a.png', error: 'cover failed' }],
    });

    const dispatchFails = await sendVideoAttachments(
      {
        uploadFile: vi.fn(async () => 'file:key'),
        uploadImage: vi.fn(async () => 'image:key'),
        dispatch: vi.fn(async () => { throw new Error('dispatch failed'); }),
      },
      'cli_app',
      [{ videoPath: '/tmp/b.mp4', coverPath: '/tmp/b.png', durationMs: 0 }],
    );
    expect(dispatchFails).toEqual({
      sent: [],
      failed: [{ path: '/tmp/b.mp4', coverPath: '/tmp/b.png', error: 'dispatch failed' }],
    });
  });

  it('routes the FIRST video through primaryDispatch (quote chain) and later videos through dispatch', async () => {
    // Pure-video sends have no card primary, so the first media message must go
    // through primaryDispatch to keep the chat-scope quote/reply chain — the rest
    // stay best-effort via plain dispatch. Regression guard for Codex P2.
    const uploadFile = vi.fn(async (_app: string, p: string) => `file:${p}`);
    const uploadImage = vi.fn(async (_app: string, p: string) => `image:${p}`);
    const primaryDispatch = vi.fn(async (content: string) => `primary:${content}`);
    const dispatch = vi.fn(async (content: string) => `plain:${content}`);

    const res = await sendVideoAttachments(
      { uploadFile, uploadImage, dispatch, primaryDispatch },
      'cli_app',
      [
        { videoPath: '/tmp/a.mp4', coverPath: '/tmp/a.png', durationMs: 0 },
        { videoPath: '/tmp/b.mp4', coverPath: '/tmp/b.png', durationMs: 0 },
      ],
    );

    expect(primaryDispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(res.failed).toEqual([]);
    expect(res.sent[0]).toBe('primary:{"file_key":"file:/tmp/a.mp4","image_key":"image:/tmp/a.png","duration":0}');
    expect(res.sent[1]).toBe('plain:{"file_key":"file:/tmp/b.mp4","image_key":"image:/tmp/b.png","duration":0}');
  });

  it('hands the primary (quote) slot to the next video when the first one fails to send', async () => {
    const uploadFile = vi.fn(async (_app: string, p: string) => {
      if (p === '/tmp/a.mp4') throw new Error('upload failed');
      return `file:${p}`;
    });
    const uploadImage = vi.fn(async (_app: string, p: string) => `image:${p}`);
    const primaryDispatch = vi.fn(async (content: string) => `primary:${content}`);
    const dispatch = vi.fn(async (content: string) => `plain:${content}`);

    const res = await sendVideoAttachments(
      { uploadFile, uploadImage, dispatch, primaryDispatch },
      'cli_app',
      [
        { videoPath: '/tmp/a.mp4', coverPath: '/tmp/a.png', durationMs: 0 },
        { videoPath: '/tmp/b.mp4', coverPath: '/tmp/b.png', durationMs: 0 },
      ],
    );

    // a.mp4 upload failed → primary slot inherited by b.mp4.
    expect(primaryDispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(res.sent).toEqual(['primary:{"file_key":"file:/tmp/b.mp4","image_key":"image:/tmp/b.png","duration":0}']);
    expect(res.failed).toEqual([{ path: '/tmp/a.mp4', coverPath: '/tmp/a.png', error: 'upload failed' }]);
  });
});
