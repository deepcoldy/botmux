import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LarkAttachment } from '../types.js';
import { getAttachmentsDir } from './attachment-path.js';

export const DASHBOARD_IMAGE_MAX_COUNT = 8;
export const DASHBOARD_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const DASHBOARD_IMAGE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export interface DashboardImageUpload {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export type DashboardImagesResult =
  | { ok: true; images: DashboardImageUpload[] }
  | { ok: false; error: string };

function hasExpectedSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/gif') return bytes.length >= 6 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a');
  if (mimeType === 'image/webp') {
    return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function decodeBase64(value: string): Buffer | null {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 ? bytes : null;
}

function normalizedImageName(value: unknown, mimeType: string, index: number): string {
  const extension = IMAGE_EXTENSIONS[mimeType];
  const raw = typeof value === 'string' ? basename(value.trim()) : '';
  const stem = (raw ? raw.slice(0, raw.length - extname(raw).length) : `pasted-image-${index + 1}`)
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80) || `pasted-image-${index + 1}`;
  return `${stem}${extension}`;
}

/** Validate browser-pasted images before any group or session is created.
 * SVG is deliberately excluded: the dashboard only accepts bounded raster
 * formats and verifies the file signature instead of trusting MIME/filename. */
export function parseDashboardImageUploads(value: unknown): DashboardImagesResult {
  if (value === undefined || value === null) return { ok: true, images: [] };
  if (!Array.isArray(value)) return { ok: false, error: 'bad_images' };
  if (value.length > DASHBOARD_IMAGE_MAX_COUNT) return { ok: false, error: 'too_many_images' };

  const images: DashboardImageUpload[] = [];
  let totalBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== 'object') return { ok: false, error: 'bad_image' };
    const mimeType = typeof (item as any).mimeType === 'string' ? (item as any).mimeType.trim().toLowerCase() : '';
    if (!IMAGE_EXTENSIONS[mimeType]) return { ok: false, error: 'unsupported_image_type' };
    const dataBase64 = typeof (item as any).dataBase64 === 'string' ? (item as any).dataBase64.trim() : '';
    const bytes = decodeBase64(dataBase64);
    if (!bytes || !hasExpectedSignature(bytes, mimeType)) return { ok: false, error: 'invalid_image_data' };
    if (bytes.length > DASHBOARD_IMAGE_MAX_BYTES) return { ok: false, error: 'image_too_large' };
    totalBytes += bytes.length;
    if (totalBytes > DASHBOARD_IMAGE_MAX_TOTAL_BYTES) return { ok: false, error: 'images_too_large' };
    images.push({
      name: normalizedImageName((item as any).name, mimeType, index),
      mimeType,
      dataBase64,
    });
  }
  return { ok: true, images };
}

/** Persist validated uploads inside this bot's read-isolation attachment
 * bucket. Each target daemon writes its own copy, so no bot needs access to a
 * sibling appId's files. */
export function materializeDashboardImages(
  larkAppId: string,
  images: DashboardImageUpload[],
): LarkAttachment[] {
  if (images.length === 0) return [];
  const messageId = `dashboard-${randomUUID()}`;
  const dir = getAttachmentsDir(larkAppId, messageId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    return images.map((image, index) => {
      const path = join(dir, `${String(index + 1).padStart(2, '0')}-${image.name}`);
      writeFileSync(path, Buffer.from(image.dataBase64, 'base64'), { mode: 0o600, flag: 'wx' });
      return { type: 'image' as const, path, name: image.name };
    });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Remove only a materialization directory created by the helper above.
 * Bucket and basename checks keep cleanup scoped to this bot's exact
 * attachment directory even if a malformed path reaches this function. */
export function cleanupMaterializedDashboardImages(
  larkAppId: string,
  attachments: readonly LarkAttachment[],
): void {
  if (attachments.length === 0) return;
  const bucket = resolve(getAttachmentsDir(larkAppId, '.'));
  const dirs = new Set(attachments.map(attachment => resolve(dirname(attachment.path))));
  for (const dir of dirs) {
    if (dirname(dir) !== bucket || !basename(dir).startsWith('dashboard-')) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}
