import { describe, expect, it, vi } from 'vitest';

import {
  dispatchPrimaryMessage,
  findStdinAliasAttachment,
  normalizeInteractiveCardInput,
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

describe('normalizeInteractiveCardInput', () => {
  const card = {
    schema: '2.0',
    body: {
      direction: 'vertical',
      elements: [{ tag: 'markdown', content: 'hello' }],
    },
  };

  it('accepts direct card JSON and serializes it for interactive send', () => {
    const res = normalizeInteractiveCardInput(JSON.stringify(card));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.card).toEqual(card);
    expect(res.cardJson).toBe(JSON.stringify(card));
  });

  it('unwraps msg_type=interactive with card object or string content', () => {
    const wrappedCard = normalizeInteractiveCardInput(JSON.stringify({
      msg_type: 'interactive',
      card,
    }));
    expect(wrappedCard.ok).toBe(true);
    if (wrappedCard.ok) expect(wrappedCard.card).toEqual(card);

    const wrappedContent = normalizeInteractiveCardInput(JSON.stringify({
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }));
    expect(wrappedContent.ok).toBe(true);
    if (wrappedContent.ok) expect(wrappedContent.card).toEqual(card);
  });

  it('rejects non-interactive wrappers, invalid JSON, and non-object cards', () => {
    expect(normalizeInteractiveCardInput('{').ok).toBe(false);
    expect(normalizeInteractiveCardInput(JSON.stringify({ msg_type: 'text', content: '{}' })).ok).toBe(false);
    expect(normalizeInteractiveCardInput(JSON.stringify({ msg_type: 'interactive', content: '[]' })).ok).toBe(false);
  });

  it('rejects callback actions so custom cards cannot enter botmux action handlers', () => {
    const res = normalizeInteractiveCardInput(JSON.stringify({
      schema: '2.0',
      body: {
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: 'close' },
          behaviors: [{ type: 'callback', value: { action: 'close', root_id: 'om_root' } }],
        }],
      },
    }));

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('callback');
  });

  it('rejects value.key dropdowns (adopt/worktree namespace, not just value.action)', () => {
    // Replicates botmux's own select_static shape (card-builder.ts): the dropdown
    // dispatch discriminator is `value.key`, not `value.action`. A hand-crafted
    // card mimicking it must be rejected too, else it reaches the adopt/worktree
    // handlers once an operator picks an option.
    const res = normalizeInteractiveCardInput(JSON.stringify({
      config: { wide_screen_mode: true },
      elements: [{
        tag: 'action',
        actions: [{
          tag: 'select_static',
          options: [{ text: { tag: 'plain_text', content: 'x' }, value: 'om_target' }],
          value: { key: 'adopt_select', root_id: 'om_target' },
        }],
      }],
    }));

    // Rejected as an interactive control (select_static); the botmux `value.key`
    // dispatch surface is a subset of that broader display-only rejection.
    expect(res.ok).toBe(false);
  });

  it('rejects a keyless option dropdown carrying only value.root_id (plain repo-switch surface)', () => {
    // The repo-select branch acts on a bare `option + value.root_id` with NO
    // action/key — a plain switch to the picked path. A card carrying just
    // root_id (no action, no key) must still be rejected, else it can drive a
    // session's working dir to an arbitrary path once an operator picks.
    const res = normalizeInteractiveCardInput(JSON.stringify({
      elements: [{
        tag: 'action',
        actions: [{
          tag: 'select_static',
          options: [{ text: { tag: 'plain_text', content: '/etc' }, value: '/etc' }],
          value: { root_id: 'om_target' },
        }],
      }],
    }));

    // Rejected as an interactive control; the bare-root_id repo-switch surface is
    // a subset of the display-only rejection (and the handler seal is the
    // authoritative backstop — see card-handler-repo-select tests).
    expect(res.ok).toBe(false);
  });

  it('rejects real form submit/reset buttons (they also fire a card callback)', () => {
    // Feishu's real form-button fields, per settings-card.ts / card-builder.ts:
    //   v2 → form_action_type: 'submit' | 'reset'
    //   v1 → action_type: 'form_submit' | 'form_reset'
    const v2Submit = normalizeInteractiveCardInput(JSON.stringify({
      schema: '2.0',
      body: {
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: 'submit' },
          form_action_type: 'submit',
        }],
      },
    }));
    expect(v2Submit.ok).toBe(false);
    if (!v2Submit.ok) expect(v2Submit.error).toContain('.form_action_type');

    const v1Submit = normalizeInteractiveCardInput(JSON.stringify({
      elements: [{
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: 'submit' },
          action_type: 'form_submit',
        }],
      }],
    }));
    expect(v1Submit.ok).toBe(false);
    if (!v1Submit.ok) expect(v1Submit.error).toContain('.action_type');
  });

  it('rejects legacy callback controls even with a non-botmux value payload (display-only)', () => {
    // Custom cards are display + open_url only. A v1 callback button / select
    // carrying an arbitrary `value` (no botmux action/key/root_id) still fires
    // card.action.trigger on click — reject it too, so the card can't ship inert
    // interactive controls and the "display-only" promise holds.
    const button = normalizeInteractiveCardInput(JSON.stringify({
      elements: [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: 'x' }, value: { foo: 'bar' } }] }],
    }));
    expect(button.ok).toBe(false);

    const select = normalizeInteractiveCardInput(JSON.stringify({
      elements: [{ tag: 'action', actions: [{ tag: 'select_static', options: [{ text: { tag: 'plain_text', content: 'o' }, value: 'o' }], value: { foo: 'bar' } }] }],
    }));
    expect(select.ok).toBe(false);

    // Also a value-less interactive control (selection still fires a callback).
    const bareSelect = normalizeInteractiveCardInput(JSON.stringify({
      elements: [{ tag: 'action', actions: [{ tag: 'select_static', options: [{ text: { tag: 'plain_text', content: 'o' }, value: 'o' }] }] }],
    }));
    expect(bareSelect.ok).toBe(false);
  });

  it('rejects a button with a STRING callback value (action.value may be string, not just object)', () => {
    const res = normalizeInteractiveCardInput(JSON.stringify({
      elements: [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: 'x' }, value: 'opaque-callback' }] }],
    }));
    expect(res.ok).toBe(false);
  });

  it('rejects a plain button with no open_url (still fires a callback on click)', () => {
    const res = normalizeInteractiveCardInput(JSON.stringify({
      elements: [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: 'x' } }] }],
    }));
    expect(res.ok).toBe(false);
  });

  it('rejects select_img (interactive image-select component)', () => {
    const res = normalizeInteractiveCardInput(JSON.stringify({
      elements: [{ tag: 'action', actions: [{ tag: 'select_img', options: [{ img_key: 'k', value: 'v' }] }] }],
    }));
    expect(res.ok).toBe(false);
  });

  it('still accepts pure display cards: open_url buttons, images, columns, charts with tagged/nested value data', () => {
    const display = normalizeInteractiveCardInput(JSON.stringify({
      schema: '2.0',
      header: { template: 'blue', title: { tag: 'plain_text', content: 'Status' } },
      body: {
        elements: [
          { tag: 'markdown', content: '**done**' },
          { tag: 'img', img_key: 'img_x', alt: { tag: 'plain_text', content: '' } },
          { tag: 'column_set', columns: [
            { tag: 'column', elements: [{ tag: 'markdown', content: 'CPU' }] },
            { tag: 'column', elements: [{ tag: 'markdown', content: '99%' }] },
          ] },
          // chart_spec is free-form user data; a data point that happens to carry
          // a `tag` + `value` object must NOT be misread as an interactive control.
          { tag: 'chart', chart_spec: { series: [{ tag: 'prod', value: { x: 1, y: 2 } }] } },
          { tag: 'button', text: { tag: 'plain_text', content: 'open' }, behaviors: [{ type: 'open_url', default_url: 'https://x' }] },
          { tag: 'button', text: { tag: 'plain_text', content: 'jump' }, url: 'https://y' },
        ],
      },
    }));
    expect(display.ok).toBe(true);
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
