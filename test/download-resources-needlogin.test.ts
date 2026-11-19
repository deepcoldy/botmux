/**
 * downloadResources only flags `needLogin` (→ the "/login" prompt) when the
 * User Token is genuinely missing or rejected (UserTokenMissingError) — NOT for
 * an ordinary download failure with a valid token. Regression for the false
 * "缺少 User Token，请 /login" prompt on forwarded card-images / cross-tenant
 * resources, which used to be triggered by a substring match on the error text.
 *
 * Run: pnpm vitest run test/download-resources-needlogin.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Define the error class INSIDE the factory to avoid vi.mock hoisting issues;
// session-manager imports UserTokenMissingError from this same mocked module,
// so `instanceof` lines up across the test and the code under test.
vi.mock('../src/im/lark/client.js', () => {
  class UserTokenMissingError extends Error {
    constructor(message: string) { super(message); this.name = 'UserTokenMissingError'; }
  }
  return {
    listChatBotMembers: vi.fn(),
    downloadMessageResource: vi.fn(),
    UserTokenMissingError,
  };
});

import { downloadMessageResource, UserTokenMissingError } from '../src/im/lark/client.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { downloadResources, formatAttachmentsHint } from '../src/core/session-manager.js';

const img = { type: 'image' as const, key: 'k', name: 'k.jpg' };

describe('downloadResources — needLogin gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets needLogin when the token is genuinely missing/rejected', async () => {
    (downloadMessageResource as any).mockRejectedValue(new (UserTokenMissingError as any)('no token, send /login'));
    const { attachments, needLogin } = await downloadResources('app', 'om_1', [img]);
    expect(attachments).toEqual([]);
    expect(needLogin).toBe(true);
  });

  it('does NOT set needLogin for a plain download failure with a valid token', async () => {
    // e.g. forwarded card image / cross-tenant resource that 4xx/5xx's even
    // though the token is valid — must NOT trigger a "/login" prompt.
    (downloadMessageResource as any).mockRejectedValue(new Error('Resource download failed: HTTP 403 forbidden'));
    const { attachments, needLogin } = await downloadResources('app', 'om_1', [img]);
    expect(attachments).toEqual([]);
    expect(needLogin).toBe(false);
  });

  it('collects attachments and leaves needLogin false on success', async () => {
    (downloadMessageResource as any).mockResolvedValue(undefined);
    const { attachments, needLogin } = await downloadResources('app', 'om_1', [img]);
    expect(needLogin).toBe(false);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ type: 'image', name: 'k.jpg' });
  });

  it('saves into the per-appId bucket (attachments/<appId>/<messageId>/) for the read-isolation carve-out', async () => {
    // Read isolation wholesale-denies attachments/ and re-allows only
    // attachments/<own appId>/ — the storage layout must match the carve-out key.
    (downloadMessageResource as any).mockResolvedValue(undefined);
    const { attachments } = await downloadResources('app', 'om_1', [img]);
    expect(attachments[0].path).toMatch(/\/attachments\/app\/om_1\/k\.jpg$/);
    expect((downloadMessageResource as any).mock.calls[0][4]).toMatch(/\/attachments\/app\/om_1\/k\.jpg$/);
  });

  it('soft-fails (no throw) on a path-unsafe appId — text still processes, no download attempted', async () => {
    // A hand-edited bots.json could carry an appId with a path separator. getAttachmentsDir
    // → assertSafeAppId throws; downloadResources must catch it and return empty rather than
    // sink the whole message (event-dispatcher would drop the text too). Real cli_xxx ids pass.
    (downloadMessageResource as any).mockResolvedValue(undefined);
    const { attachments, needLogin } = await downloadResources('bad/app', 'om_1', [img]);
    expect(attachments).toEqual([]);
    expect(needLogin).toBe(false);
    expect(downloadMessageResource as any).not.toHaveBeenCalled();
  });
});

it('normalizes actual GIF bytes and carries the temporal hint into the CLI prompt', async () => {
  vi.mocked(downloadMessageResource).mockImplementation(async (_app, _msg, _key, _type, path) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  });
  const { attachments, needLogin } = await downloadResources('app', 'om_gif_format', [img]);
  expect(needLogin).toBe(false);
  expect(attachments[0]).toMatchObject({ name: 'k.gif', resourceKey: 'k', mimeType: 'image/gif' });
  const prompt = formatAttachmentsHint(attachments);
  expect(prompt).toContain('k.gif');
  expect(prompt).toContain('mime_type="image/gif"');
  expect(prompt).toContain('Inspect or extract frames in time order');
  expect(formatAttachmentsHint([{ type: 'image', name: 'old.jpg', path: '/tmp/old.jpg' }])).toContain('<image n="1" path="/tmp/old.jpg" />');
});


describe('video attachments and CLI media hints', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves video body type and path through the attachment downloader', async () => {
    vi.mocked(downloadMessageResource).mockResolvedValue(undefined);
    const { attachments, needLogin } = await downloadResources('app', 'om_video', [
      { type: 'video', key: 'video_body', name: 'clip.mp4' },
    ], 'ou_sender');
    expect(needLogin).toBe(false);
    expect(attachments).toMatchObject([{ type: 'video', name: 'clip.mp4', resourceKey: 'video_body' }]);
    expect(attachments[0].path).toMatch(/\/attachments\/app\/om_video\/clip\.mp4$/);
    expect(vi.mocked(downloadMessageResource).mock.calls[0].slice(0, 4)).toEqual(['app', 'om_video', 'video_body', 'video']);
  });

  it('keeps independent image/file/video indices and escapes video paths', () => {
    const prompt = formatAttachmentsHint([
      { type: 'video', path: '/tmp/a&b.mp4', name: 'a&b.mp4' },
      { type: 'image', path: '/tmp/image.png', name: 'image.png' },
      { type: 'file', path: '/tmp/file.pdf', name: 'file.pdf' },
      { type: 'video', path: '/tmp/next.mp4', name: 'next.mp4' },
    ], 'en', 'zcode');
    expect(prompt).toContain('<video n="1" path="/tmp/a&amp;b.mp4" />');
    expect(prompt).toContain('<video n="2" path="/tmp/next.mp4" />');
    expect(prompt).toContain('<image n="1" path="/tmp/image.png" />');
    expect(prompt).toContain('<file n="1" path="/tmp/file.pdf" />');
    expect(prompt).toContain('Prefer Read or');
    expect(prompt).not.toContain('ReadMediaFile');
  });

  it('names Kimi media tools only for Kimi and leaves non-video prompts alone', () => {
    const video = [{ type: 'video' as const, path: '/tmp/clip.mp4', name: 'clip.mp4' }];
    expect(formatAttachmentsHint(video, 'en', 'kimi')).toContain('Prefer ReadMediaFile');
    expect(formatAttachmentsHint(video, 'en', 'codex')).not.toContain('ReadMediaFile');
    expect(formatAttachmentsHint([{ type: 'image', path: '/tmp/img.png', name: 'img.png' }], 'en', 'codex'))
      .not.toContain('<video_hint>');
  });
});
