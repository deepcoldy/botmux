/**
 * Session-group avatar branding (p2pMode='group').
 *
 * Every private-chat session group keeps the official botmux ribbon logo and
 * only swaps the old white background for one of ten deterministic gradients.
 * The rendered PNG is uploaded once per bot×variant and cached as an
 * image_key in `${dataDir}/session-avatar-cache-${appId}.json`.
 *
 * The logo ships inline so the compiled single-file binary never depends on a
 * real on-disk asset path under `/$bunfs`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { getBot, getBotClient } from '../bot-registry.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { SESSION_GROUP_AVATAR_LOGO_BASE64 } from './session-group-avatar-logo-data.js';

const AVATAR_SIZE = 360;
const MAX_PNG_PIXELS = 4096 * 4096;
const LOGO_X = 69;
const LOGO_Y = 86;
const LOGO_WIDTH = 221;
const LOGO_HEIGHT = 187;

export interface AvatarVariant {
  id: string;
  corners: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
  glow: readonly [number, number, number];
}

export const SESSION_GROUP_AVATAR_VARIANTS: readonly AvatarVariant[] = [
  {
    id: 'glacier',
    corners: [
      [126, 210, 255],
      [43, 126, 238],
      [63, 197, 182],
      [14, 93, 196],
    ],
    glow: [236, 248, 255],
  },
  {
    id: 'sunset',
    corners: [
      [255, 190, 110],
      [255, 108, 108],
      [255, 144, 78],
      [214, 71, 94],
    ],
    glow: [255, 239, 221],
  },
  {
    id: 'mint',
    corners: [
      [156, 231, 174],
      [54, 183, 122],
      [99, 210, 194],
      [26, 129, 116],
    ],
    glow: [238, 252, 243],
  },
  {
    id: 'amber',
    corners: [
      [255, 220, 120],
      [255, 170, 76],
      [245, 162, 68],
      [199, 102, 34],
    ],
    glow: [255, 244, 220],
  },
  {
    id: 'berry',
    corners: [
      [255, 170, 193],
      [233, 88, 139],
      [255, 132, 120],
      [185, 52, 96],
    ],
    glow: [255, 235, 241],
  },
  {
    id: 'slate',
    corners: [
      [152, 188, 230],
      [71, 98, 177],
      [109, 146, 214],
      [38, 63, 126],
    ],
    glow: [232, 240, 252],
  },
  {
    id: 'violet',
    corners: [
      [203, 186, 255],
      [138, 96, 226],
      [156, 116, 238],
      [86, 48, 168],
    ],
    glow: [244, 238, 255],
  },
  {
    id: 'lime',
    corners: [
      [206, 240, 128],
      [124, 196, 72],
      [156, 218, 92],
      [74, 138, 34],
    ],
    glow: [247, 253, 228],
  },
  {
    id: 'lemon',
    corners: [
      [255, 238, 140],
      [245, 190, 60],
      [252, 210, 96],
      [196, 150, 28],
    ],
    glow: [255, 250, 224],
  },
  {
    id: 'magenta',
    corners: [
      [255, 184, 232],
      [226, 92, 186],
      [240, 126, 206],
      [166, 44, 132],
    ],
    glow: [255, 238, 249],
  },
] as const;

export const SESSION_GROUP_AVATAR_LOGO_BOUNDS = Object.freeze({
  x: LOGO_X,
  y: LOGO_Y,
  width: LOGO_WIDTH,
  height: LOGO_HEIGHT,
});

interface AvatarCache {
  imageKeys?: Record<string, string>;
}

interface DecodedPng {
  width: number;
  height: number;
  data: Uint8Array;
}

let decodedLogoCache: DecodedPng | null = null;

function cachePath(appId: string): string {
  return join(config.session.dataDir, `session-avatar-cache-${appId}.json`);
}

function loadCache(appId: string): AvatarCache {
  try {
    const fp = cachePath(appId);
    if (existsSync(fp)) return JSON.parse(readFileSync(fp, 'utf-8')) as AvatarCache;
  } catch {
    // Corrupted cache falls back to a fresh render/upload.
  }
  return {};
}

function saveCache(appId: string, cache: AvatarCache): void {
  try {
    const fp = cachePath(appId);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`[session-avatar] cache persist failed: ${err}`);
  }
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (const codePoint of input) {
    const code = codePoint.codePointAt(0) ?? 0;
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (code >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (code >>> 16) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (code >>> 24) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function pickSessionGroupAvatarVariant(chatId: string): AvatarVariant {
  const hash = fnv1a32(chatId);
  return SESSION_GROUP_AVATAR_VARIANTS[hash % SESSION_GROUP_AVATAR_VARIANTS.length]!;
}

function clampByte(value: number): number {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function fillBackground(rgba: Uint8Array, variant: AvatarVariant): void {
  const [topLeft, topRight, bottomLeft, bottomRight] = variant.corners;
  const [glowR, glowG, glowB] = variant.glow;
  const maxDistance = Math.sqrt(0.5 ** 2 + 0.5 ** 2);

  for (let y = 0; y < AVATAR_SIZE; y += 1) {
    const ty = y / (AVATAR_SIZE - 1);
    for (let x = 0; x < AVATAR_SIZE; x += 1) {
      const tx = x / (AVATAR_SIZE - 1);
      const rowMixLeft = [
        mix(topLeft[0], bottomLeft[0], ty),
        mix(topLeft[1], bottomLeft[1], ty),
        mix(topLeft[2], bottomLeft[2], ty),
      ];
      const rowMixRight = [
        mix(topRight[0], bottomRight[0], ty),
        mix(topRight[1], bottomRight[1], ty),
        mix(topRight[2], bottomRight[2], ty),
      ];

      let r = mix(rowMixLeft[0], rowMixRight[0], tx);
      let g = mix(rowMixLeft[1], rowMixRight[1], tx);
      let b = mix(rowMixLeft[2], rowMixRight[2], tx);

      const glowDx = (x - 92) / 230;
      const glowDy = (y - 78) / 220;
      const glowStrength = Math.max(0, 1 - Math.sqrt(glowDx * glowDx + glowDy * glowDy));
      r = mix(r, glowR, glowStrength * 0.28);
      g = mix(g, glowG, glowStrength * 0.28);
      b = mix(b, glowB, glowStrength * 0.28);

      const dx = tx - 0.5;
      const dy = ty - 0.5;
      const vignette = Math.max(0, Math.sqrt(dx * dx + dy * dy) / maxDistance - 0.2) / 0.8;
      const shade = 1 - vignette * 0.14;

      const index = (y * AVATAR_SIZE + x) * 4;
      rgba[index] = clampByte(r * shade);
      rgba[index + 1] = clampByte(g * shade);
      rgba[index + 2] = clampByte(b * shade);
      rgba[index + 3] = 255;
    }
  }
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! << 24)
    | (bytes[offset + 1]! << 16)
    | (bytes[offset + 2]! << 8)
    | bytes[offset + 3]!
  ) >>> 0;
}

export function decodePngRgba(png: Uint8Array): DecodedPng {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < signature.length || !Buffer.from(png.subarray(0, signature.length)).equals(signature)) {
    throw new Error('invalid PNG signature');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  for (let offset = 8; offset + 12 <= png.length;) {
    const length = readU32be(png, offset);
    offset += 4;
    const type = Buffer.from(png.subarray(offset, offset + 4)).toString('ascii');
    offset += 4;
    const chunk = png.subarray(offset, offset + length);
    offset += length;
    offset += 4; // CRC

    if (type === 'IHDR') {
      width = readU32be(chunk, 0);
      height = readU32be(chunk, 4);
      bitDepth = chunk[8]!;
      colorType = chunk[9]!;
      interlace = chunk[12]!;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(chunk));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (width <= 0 || height <= 0) throw new Error('PNG missing IHDR');
  if (width * height > MAX_PNG_PIXELS) {
    throw new Error(`PNG exceeds pixel limit (${MAX_PNG_PIXELS})`);
  }
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`unsupported PNG format (${bitDepth}/${colorType}/${interlace})`);
  }

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const expected = height * (stride + 1);
  const inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  if (inflated.length !== expected) {
    throw new Error(`unexpected PNG payload size (${inflated.length} !== ${expected})`);
  }

  const rgba = new Uint8Array(width * height * bytesPerPixel);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (stride + 1)]!;
    const scanline = inflated.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    current.set(scanline);

    switch (filter) {
      case 0:
        break;
      case 1:
        for (let i = bytesPerPixel; i < stride; i += 1) current[i] = (current[i]! + current[i - bytesPerPixel]!) & 0xff;
        break;
      case 2:
        for (let i = 0; i < stride; i += 1) current[i] = (current[i]! + previous[i]!) & 0xff;
        break;
      case 3:
        for (let i = 0; i < stride; i += 1) {
          const left = i >= bytesPerPixel ? current[i - bytesPerPixel]! : 0;
          const up = previous[i]!;
          current[i] = (current[i]! + Math.floor((left + up) / 2)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i += 1) {
          const left = i >= bytesPerPixel ? current[i - bytesPerPixel]! : 0;
          const up = previous[i]!;
          const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel]! : 0;
          current[i] = (current[i]! + paeth(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error(`unsupported PNG filter ${filter}`);
    }

    rgba.set(current, y * stride);
    previous.set(current);
  }

  return { width, height, data: rgba };
}

function paeth(left: number, up: number, upLeft: number): number {
  const predictor = left + up - upLeft;
  const pLeft = Math.abs(predictor - left);
  const pUp = Math.abs(predictor - up);
  const pUpLeft = Math.abs(predictor - upLeft);
  if (pLeft <= pUp && pLeft <= pUpLeft) return left;
  if (pUp <= pUpLeft) return up;
  return upLeft;
}

function decodeInlineLogo(): DecodedPng {
  if (!decodedLogoCache) {
    decodedLogoCache = decodePngRgba(Buffer.from(SESSION_GROUP_AVATAR_LOGO_BASE64, 'base64'));
    if (decodedLogoCache.width !== LOGO_WIDTH || decodedLogoCache.height !== LOGO_HEIGHT) {
      throw new Error(`unexpected session logo size ${decodedLogoCache.width}x${decodedLogoCache.height}`);
    }
  }
  return decodedLogoCache;
}

export function decodeInlineSessionGroupLogo(): DecodedPng {
  return decodeInlineLogo();
}

function blendPixel(target: Uint8Array, index: number, sr: number, sg: number, sb: number, sa: number): void {
  if (sa <= 0) return;

  const dstA = target[index + 3]! / 255;
  const srcA = sa / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;

  const dstR = target[index]!;
  const dstG = target[index + 1]!;
  const dstB = target[index + 2]!;

  target[index] = clampByte((sr * srcA + dstR * dstA * (1 - srcA)) / outA);
  target[index + 1] = clampByte((sg * srcA + dstG * dstA * (1 - srcA)) / outA);
  target[index + 2] = clampByte((sb * srcA + dstB * dstA * (1 - srcA)) / outA);
  target[index + 3] = clampByte(outA * 255);
}

function compositeLogo(canvas: Uint8Array): void {
  const logo = decodeInlineLogo();
  for (let y = 0; y < logo.height; y += 1) {
    for (let x = 0; x < logo.width; x += 1) {
      const sourceIndex = (y * logo.width + x) * 4;
      const targetIndex = ((LOGO_Y + y) * AVATAR_SIZE + (LOGO_X + x)) * 4;
      blendPixel(
        canvas,
        targetIndex,
        logo.data[sourceIndex]!,
        logo.data[sourceIndex + 1]!,
        logo.data[sourceIndex + 2]!,
        logo.data[sourceIndex + 3]!,
      );
    }
  }
}

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), out.length - 4);
  return out;
}

export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function renderSessionGroupAvatarPng(variant: AvatarVariant): Buffer {
  const rgba = new Uint8Array(AVATAR_SIZE * AVATAR_SIZE * 4);
  fillBackground(rgba, variant);
  compositeLogo(rgba);
  return encodePngRgba(AVATAR_SIZE, AVATAR_SIZE, rgba);
}

async function ensureAvatarImageKey(larkAppId: string, variant: AvatarVariant): Promise<string | null> {
  const cache = loadCache(larkAppId);
  const imageKeys = cache.imageKeys ?? {};
  const cached = imageKeys[variant.id];
  if (cached) return cached;

  try {
    const client: any = getBotClient(larkAppId);
    const res = await client.im.v1.image.create({
      data: {
        image_type: 'avatar',
        image: renderSessionGroupAvatarPng(variant),
      },
    });
    const imageKey = res?.image_key;
    if (!imageKey) throw new Error(`no image_key in response (${JSON.stringify(res)})`);
    cache.imageKeys = { ...imageKeys, [variant.id]: imageKey };
    saveCache(larkAppId, cache);
    logger.info(`[session-avatar] uploaded ${variant.id} for ${larkAppId} -> ${imageKey}`);
    return imageKey;
  } catch (err) {
    logger.warn(`[session-avatar] avatar upload failed for ${variant.id}: ${err}`);
    return null;
  }
}

export async function applySessionGroupAvatar(larkAppId: string, chatId: string): Promise<void> {
  try {
    const cfg = getBot(larkAppId).config;
    if (cfg.sessionGroup?.avatar === 'off') return;

    const variant = pickSessionGroupAvatarVariant(chatId);
    const imageKey = await ensureAvatarImageKey(larkAppId, variant);
    if (!imageKey) return;

    const client: any = getBotClient(larkAppId);
    const res = await client.im.v1.chat.update({
      path: { chat_id: chatId },
      data: { avatar: imageKey },
    });
    if (res?.code !== 0 && res?.code !== undefined) {
      logger.warn(`[session-avatar] chat.update avatar failed for ${chatId.substring(0, 12)}: ${res?.msg} (code ${res?.code})`);
      return;
    }
    logger.info(`[session-avatar] applied ${variant.id} to ${chatId.substring(0, 12)}`);
  } catch (err) {
    logger.warn(`[session-avatar] applying to ${chatId.substring(0, 12)} threw: ${err}`);
  }
}
