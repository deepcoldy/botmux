import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectImageFormat, normalizeImageAttachment, imageSequenceHint } from '../src/core/attachment-image-format.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
// A valid 1x1 GIF. Detection does not claim that every GIF is animated.
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const animatedGif = Buffer.concat([gif.subarray(0, -1), gif.subarray(19, -1), Buffer.from([0x3b])]);

describe('downloaded image format', () => {
  it.each([
    [gif, '.gif'],
    [Buffer.concat([Buffer.from('GIF87a'), gif.subarray(6)]), '.gif'],
    [Buffer.from('89504e470d0a1a0a', 'hex'), '.png'],
    [Buffer.from('ffd8ffe0', 'hex'), '.jpg'],
    [Buffer.from('RIFF0000WEBPVP8X'), '.webp'],
  ])('recognizes bytes independently of the filename', (bytes, extension) => {
    expect(detectImageFormat(bytes)?.extension).toBe(extension);
  });

  it.each([Buffer.alloc(0), Buffer.from('GIF89a'), Buffer.from('not an image'), Buffer.from('RIFF0000WAVEfmt ')])(
    'does not guess unknown or short headers', bytes => expect(detectImageFormat(bytes)).toBeUndefined(),
  );

  it('renames a jpg-named GIF without changing its bytes or resource identity; repeat downloads work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'botmux-image-')); dirs.push(dir);
    const path = join(dir, 'img_key.jpg');
    for (let attempt = 0; attempt < 2; attempt++) {
      await writeFile(path, animatedGif);
      const result = await normalizeImageAttachment({ type: 'image', path, name: 'img_key.jpg', resourceKey: 'img_key' });
      expect(result).toEqual({ type: 'image', path: join(dir, 'img_key.gif'), name: 'img_key.gif', resourceKey: 'img_key', mimeType: 'image/gif' });
      expect(await readFile(result.path)).toEqual(animatedGif);
      expect(imageSequenceHint(result)).toContain('multiple frames');
    }
  });

  it('leaves unknown image bytes and user file names untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'botmux-image-')); dirs.push(dir);
    const path = join(dir, 'original.jpg');
    await writeFile(path, 'unknown');
    const image = { type: 'image' as const, path, name: 'original.jpg' };
    expect(await normalizeImageAttachment(image)).toEqual(image);
    await writeFile(path, gif);
    const file = { ...image, type: 'file' as const };
    expect(await normalizeImageAttachment(file)).toEqual(file);
    expect(imageSequenceHint(file)).toBeUndefined();
  });
});
