import { beforeEach, describe, expect, it, vi } from 'vitest';
import { vol } from 'memfs';
import { homedir } from 'node:os';
import { resolveReplyImages, type ReplyImageState } from '../src/im/lark/reply-images.js';

vi.mock('node:fs', () => {
  // Bun deadlocks on await import inside a mock factory; require works in both runners.
  const { fs }: typeof import('memfs') = require('memfs');
  return { ...fs, default: fs };
});

const root = '/workspace/project';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');

function fixture() {
  const state: ReplyImageState = { omitImages: false };
  const upload = vi.fn(async (_bytes: Buffer) => 'img_v3_test_upload');
  return { workingDir: root, state, upload, owns: () => true };
}

describe('automatic reply image upload', () => {
  beforeEach(() => {
    vol.reset();
    vol.fromJSON({
      [`${root}/tmp/preview.png`]: png,
      [`${root}/tmp/preview (1).png`]: png,
      [`${root}/tmp/not-image.png`]: 'private text is not an image',
      '/outside/private.png': png,
    });
    vol.mkdirSync(homedir(), { recursive: true });
  });

  it.each([
    `![Preview](${root}/tmp/preview.png)`,
    '![Preview](tmp/preview.png)',
    `![Preview](file://${root}/tmp/preview.png)`,
    '![Preview](<tmp/preview (1).png> "Screenshot")',
    '![Preview](tmp/preview%20%281%29.png)',
    '![Preview][shot]\n\n[shot]: tmp/preview.png',
    '> ![Preview](tmp/preview.png)',
    '- ![Preview](tmp/preview.png)',
  ])('uploads a workspace image and rewrites its source: %s', async markdown => {
    const options = fixture();
    const output = await resolveReplyImages(markdown, options);
    expect(options.upload).toHaveBeenCalledExactlyOnceWith(png);
    expect(output).toContain('![Preview](img_v3_test_upload)');
  });

  it('keeps code, escaped syntax, existing image keys, and ordinary file links unchanged', async () => {
    const options = fixture();
    const markdown = [
      '`![Example](tmp/preview.png)`',
      '```markdown\n![Example](tmp/preview.png)\n```',
      '    ![Example](tmp/preview.png)',
      '\\![Example](tmp/preview.png)',
      '![Uploaded](img_v3_existing)',
      '[File](tmp/preview.png)',
    ].join('\n\n');
    expect(await resolveReplyImages(markdown, options)).toBe(markdown);
    expect(options.upload).not.toHaveBeenCalled();
  });

  it('recognizes model-escaped fences before deciding whether to upload an image', async () => {
    const options = fixture();
    const markdown = '\\`\\`\\`markdown\n![Example](tmp/preview.png)\n\\`\\`\\`';
    await resolveReplyImages(markdown, options);
    expect(options.upload).not.toHaveBeenCalled();
  });

  it.each([
    '/outside/private.png', '../project-neighbor/private.png', '../../outside/private.png',
    'https://example.com/preview.png', '//example.com/preview.png',
    'tmp/not-image.png', 'tmp/missing.png', 'tmp',
  ])('leaves an unauthorized or unreadable source for the text fallback: %s', async source => {
    const options = fixture();
    const markdown = `Ready. ![Preview](${source})`;
    expect(await resolveReplyImages(markdown, options)).toBe(markdown);
    expect(options.upload).not.toHaveBeenCalled();
  });

  it('rejects symlinks escaping the workspace and hardlinks to other files', async () => {
    vol.symlinkSync('/outside/private.png', `${root}/tmp/link.png`);
    vol.linkSync('/outside/private.png', `${root}/tmp/hardlink.png`);
    const options = fixture();
    const markdown = '![Link](tmp/link.png) ![Hardlink](tmp/hardlink.png)';
    expect(await resolveReplyImages(markdown, options)).toBe(markdown);
    expect(options.upload).not.toHaveBeenCalled();
  });

  it('reuses an upload for repeated references and delivery retries even if the file is removed', async () => {
    const options = fixture();
    const markdown = '![A](tmp/preview.png) ![B](tmp/preview.png)';
    const first = await resolveReplyImages(markdown, options);
    vol.unlinkSync(`${root}/tmp/preview.png`);
    expect(await resolveReplyImages(markdown, options)).toBe(first);
    expect(first).toBe('![A](img_v3_test_upload) ![B](img_v3_test_upload)');
    expect(options.upload).toHaveBeenCalledOnce();
  });

  it('does not spend the upload budget on remote images before a workspace screenshot', async () => {
    const options = fixture();
    const remote = Array.from({ length: 8 }, (_, i) => `![Remote](https://example.com/${i}.png)`).join('\n\n');
    const output = await resolveReplyImages(`${remote}\n\n![Preview](tmp/preview.png)`, options);
    expect(output).toContain('![Preview](img_v3_test_upload)');
    expect(options.upload).toHaveBeenCalledOnce();
  });

  it('keeps the body available after upload failure without repeatedly uploading on send retries', async () => {
    const options = fixture();
    options.upload.mockRejectedValue(new Error('upload unavailable'));
    const markdown = 'Ready. ![Preview](tmp/preview.png)';
    expect(await resolveReplyImages(markdown, options)).toBe(markdown);
    expect(await resolveReplyImages(markdown, options)).toBe(markdown);
    expect(options.upload).toHaveBeenCalledOnce();
  });

  it('never inserts an invalid returned image key', async () => {
    const options = fixture();
    options.upload.mockResolvedValue('/unexpected/path.png');
    const markdown = '![Preview](tmp/preview.png)';
    expect(await resolveReplyImages(markdown, options)).toBe(markdown);
  });

  it('skips uploads after image rejection or loss of session ownership', async () => {
    for (const options of [
      { ...fixture(), state: { omitImages: true } },
      { ...fixture(), owns: () => false },
    ]) {
      const markdown = '![Preview](tmp/preview.png)';
      expect(await resolveReplyImages(markdown, options)).toBe(markdown);
      expect(options.upload).not.toHaveBeenCalled();
    }
  });

  it('bounds automatic image size and count', async () => {
    const large = Buffer.alloc(8 * 1024 * 1024 + 1);
    png.copy(large);
    vol.writeFileSync(`${root}/tmp/large.png`, large);
    const options = fixture();
    expect(await resolveReplyImages('![Large](tmp/large.png)', options)).toBe('![Large](tmp/large.png)');
    expect(options.upload).not.toHaveBeenCalled();
    const images = Array.from({ length: 10 }, (_, i) => {
      vol.writeFileSync(`${root}/tmp/${i}.png`, png);
      return `![Image ${i}](tmp/${i}.png)`;
    }).join('\n\n');
    const output = await resolveReplyImages(images, fixture());
    expect(output.match(/img_v3_test_upload/g)).toHaveLength(8);
    expect(output).toContain('![Image 9](tmp/9.png)');
  });
});
