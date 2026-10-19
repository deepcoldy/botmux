/**
 * Purge undersized images from a Claude Code transcript so the session can be
 * recovered with `claude --resume` instead of `/clear`.
 *
 * Why this exists: when the CLI reads an image file whose pixel dimensions are
 * below the model API minimum (observed: 1×1 placeholder PNGs), the image
 * block stays in the session jsonl and is replayed on every later request —
 * the API answers 400 forever, including for /compact and auto-continue. The
 * only in-CLI escape is /clear (loses context). Rewriting the transcript to
 * replace the offending blocks with text, then respawning with `--resume`,
 * keeps the full text history while removing the poison.
 *
 * Scope: the pinned session jsonl PLUS `<sid>/subagents/*.jsonl` next to it
 * (Task/Agent transcripts). Every rewritten file gets a one-time
 * `.botmux-purge-bak-<ts>` backup; writes are atomic (tmp + rename).
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** API-side floor quoted in the 400 ("Minimum allowed dimension: 14 pixels"). */
export const MIN_IMAGE_DIMENSION = 14;

/** Hard skip for absurd transcripts rather than buffering gigabytes. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

export interface PurgedFile {
  file: string;
  removed: number;
  backup?: string;
}

interface ImageBlock {
  type: 'image';
  source: { type?: unknown; media_type?: unknown; data?: unknown };
}

interface Measured {
  width: number;
  height: number;
}

/** Decode pixel dimensions from an encoded image. Returns null for formats or
 *  buffers we cannot parse — an unparseable image must be left untouched
 *  (fail-safe: never delete an image the API might accept). */
export function measureImage(buf: Buffer, mediaType?: string): Measured | null {
  // PNG: signature, IHDR is the first chunk — width/height at bytes 16..23.
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50
    && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF6/89a: logical screen descriptor width/height, LE u16 at 6/8.
  if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // JPEG: walk segment markers to the first SOFn frame.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 4 < buf.length) {
      if (buf[o] !== 0xff) { o += 1; continue; }
      const marker = buf[o + 1];
      o += 2;
      // SOF0..SOF15 excluding DHT(C4), DAC(CC), and standalone RSTn/D8/Dn.
      if (marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (o + 7 > buf.length) return null;
        return { height: buf.readUInt16BE(o + 3), width: buf.readUInt16BE(o + 5) };
      }
      if (o + 2 > buf.length) return null;
      const segLen = buf.readUInt16BE(o);
      if (segLen < 2) return null;
      o += segLen;
    }
    return null;
  }
  // WebP: RIFF .... WEBP, then VP8 / VP8L / VP8X.
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP') {
    let o = 12;
    while (o + 8 <= buf.length) {
      const fourcc = buf.toString('ascii', o, o + 4);
      const size = buf.readUInt32LE(o + 4);
      const p = o + 8;
      if (fourcc === 'VP8X' && p + 10 <= buf.length) {
        // 24-bit (dimension - 1), little-endian.
        const w = 1 + buf.readUIntLE(p + 4, 3);
        const h = 1 + buf.readUIntLE(p + 7, 3);
        return { width: w, height: h };
      }
      if (fourcc === 'VP8 ' && p + 10 <= buf.length) {
        // Lossy: 3-byte frame tag, start code 9d 01 2a, then 14-bit w/h.
        if (buf[p + 3] === 0x9d && buf[p + 4] === 0x01 && buf[p + 5] === 0x2a) {
          return {
            width: buf.readUInt16LE(p + 6) & 0x3fff,
            height: buf.readUInt16LE(p + 8) & 0x3fff,
          };
        }
      }
      if (fourcc === 'VP8L' && p + 5 <= buf.length && buf[p] === 0x2f) {
        // Lossless: 14 bits (dim - 1) each, packed from byte 1.
        const bits = Number(buf.readUInt32LE(p + 1));
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      o = p + size + (size & 1);
    }
    return null;
  }
  // mediaType says image/* but the header is unknown to us.
  if (mediaType?.startsWith('image/')) return null;
  return null;
}

function isImageBlock(v: unknown): v is ImageBlock {
  return !!v && typeof v === 'object'
    && (v as { type?: unknown }).type === 'image'
    && typeof (v as ImageBlock).source === 'object'
    && (v as ImageBlock).source !== null;
}

/** Replace one undersized image block; otherwise recurse into containers.
 *  Mutates parsed JSON in place. Returns the number of replacements made. */
function sanitizeNode(node: unknown, minDimension: number): number {
  let removed = 0;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const child = node[i];
      if (isImageBlock(child)
        && child.source.type === 'base64'
        && typeof child.source.data === 'string') {
        let buf: Buffer;
        try {
          buf = Buffer.from(child.source.data, 'base64');
        } catch {
          // Bad base64 — not ours to judge; the API error will say so.
          sanitizeNode(child, minDimension);
          continue;
        }
        const dims = measureImage(buf, typeof child.source.media_type === 'string'
          ? child.source.media_type
          : undefined);
        if (dims && (dims.width < minDimension || dims.height < minDimension)) {
          node[i] = {
            type: 'text',
            text: `[botmux: removed an undersized image (${dims.width}x${dims.height} px) `
              + `that the model API rejects; minimum allowed dimension is ${minDimension}px]`,
          };
          removed += 1;
          continue;
        }
      }
      removed += sanitizeNode(child, minDimension);
    }
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      removed += sanitizeNode(value, minDimension);
    }
  }
  return removed;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

function backupPathFor(file: string): string {
  const stem = `${file}.botmux-purge-bak-${timestamp()}`;
  if (!existsSync(stem)) return stem;
  for (let i = 1; ; i += 1) {
    const candidate = `${stem}-${i}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/** Rewrite one jsonl file, backing it up first. Returns undefined when the
 *  file is untouched (no backup, no write). */
function purgeFile(file: string, minDimension: number): PurgedFile | undefined {
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch {
    return undefined;
  }
  if (raw.length === 0 || raw.length > MAX_FILE_BYTES) return undefined;
  const trailingNewline = raw[raw.length - 1] === 0x0a;
  const lines = raw.toString('utf8').split('\n');
  // A trailing newline produces a phantom empty final element; keep it out of
  // the parse/join round-trip and restore it below instead.
  if (trailingNewline) lines.pop();
  let removed = 0;
  const out: string[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      out[i] = line;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      out[i] = line;
      continue;
    }
    const n = sanitizeNode(parsed, minDimension);
    if (n > 0) {
      removed += n;
      out[i] = JSON.stringify(parsed);
    } else {
      out[i] = line;
    }
  }
  if (removed === 0) return undefined;
  const backup = backupPathFor(file);
  const tmp = `${file}.tmp-purge-${createHash('sha1').update(file).digest('hex').slice(0, 10)}`;
  writeFileSync(tmp, out.join('\n') + (trailingNewline ? '\n' : ''), 'utf8');
  // Backup the ORIGINAL bytes first, then swap the temp file into place.
  renameSync(file, backup);
  renameSync(tmp, file);
  return { file, removed, backup };
}

const SESSION_SUBDIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Purge the pinned session transcript and its Task/Agent subagent files. */
export function purgeUndersizedImages(
  mainJsonlPath: string,
  opts: { minDimension?: number } = {},
): PurgedFile[] {
  const minDimension = opts.minDimension ?? MIN_IMAGE_DIMENSION;
  const results: PurgedFile[] = [];
  const main = purgeFile(mainJsonlPath, minDimension);
  if (main) results.push(main);

  // Layout: <projectsRoot>/<cwdHash>/<sid>.jsonl with subagents at
  // <projectsRoot>/<cwdHash>/<sid>/subagents/*.jsonl.
  const sid = basename(mainJsonlPath).replace(/\.jsonl$/i, '');
  if (SESSION_SUBDIR_RE.test(sid)) {
    const subDir = join(dirname(mainJsonlPath), sid, 'subagents');
    let entries: string[];
    try {
      entries = readdirSync(subDir);
    } catch {
      return results;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const purged = purgeFile(join(subDir, name), minDimension);
      if (purged) results.push(purged);
    }
  }
  return results;
}
