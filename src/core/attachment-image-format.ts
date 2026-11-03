import { open, rename } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { LarkAttachment } from '../types.js';

/** Inspect a bounded header, not the provider's synthetic filename. No decoding/transcoding. */
export function detectImageFormat(bytes: Buffer): { extension: string; mimeType: string } | undefined {
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    return { extension: '.gif', mimeType: 'image/gif' };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: '.png', mimeType: 'image/png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: '.jpg', mimeType: 'image/jpeg' };
  }
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF'
      && bytes.toString('ascii', 8, 12) === 'WEBP'
      && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) {
    return { extension: '.webp', mimeType: 'image/webp' };
  }
  return undefined;
}

/** Only generated image names are normalized; user-supplied file names stay untouched. */
export async function normalizeImageAttachment(attachment: LarkAttachment): Promise<LarkAttachment> {
  if (attachment.type !== 'image') return attachment;
  const handle = await open(attachment.path, 'r');
  let format: ReturnType<typeof detectImageFormat>;
  try {
    const bytes = Buffer.alloc(32);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    format = detectImageFormat(bytes.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
  if (!format) return attachment;
  const extension = extname(attachment.path);
  const path = (extension ? attachment.path.slice(0, -extension.length) : attachment.path) + format.extension;
  if (path !== attachment.path) await rename(attachment.path, path);
  return { ...attachment, path, name: basename(path), mimeType: format.mimeType };
}

export function imageSequenceHint(attachment: LarkAttachment): string | undefined {
  if (attachment.type !== 'image' || attachment.mimeType !== 'image/gif') return undefined;
  return 'GIF may contain multiple frames. Inspect or extract frames in time order before explaining motion or user actions; a single image view may show only one frame.';
}
