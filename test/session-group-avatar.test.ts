import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_GROUP_AVATAR_LOGO_BASE64 } from '../src/services/session-group-avatar-logo-data.js';

const APP = 'cli_testapp';
const AVATAR_SIZE = 360;
const LOGO_WIDTH = 221;
const LOGO_HEIGHT = 187;
const LOGO_BASE64_SHA256 = '24fc45b635a2ffe1bdc454bcc467c86862dfb8d0def91b4af47c884d7c1b8940';
const LOGO_BYTES_SHA256 = 'da07572f73ba70a360fb397847f39b0833fc2c9a2830c090c6dccc9fe374d34a';
const LOGO_RGBA_SHA256 = '2647768996e0a45b9213caedac807f52a10c3d6ae7d88b038417ca6bbfa4c0a3';
const OPAQUE_SAMPLE = Object.freeze({ x: 45, y: 30 });
const EDGE_SAMPLE = Object.freeze({ x: 174, y: 169 });
const TRANSPARENT_SAMPLE = Object.freeze({ x: 0, y: 0 });

let tempDir = '';
let nextImage = 1;

const imageCreateMock = vi.fn(async () => ({ image_key: `img_${nextImage++}` }));
const chatUpdateMock = vi.fn(async () => ({ code: 0 }));

vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { sessionGroup: { avatar: 'auto' } } }),
  getBotClient: () => ({
    im: {
      v1: {
        image: { create: (...args: any[]) => imageCreateMock(...args) },
        chat: { update: (...args: any[]) => chatUpdateMock(...args) },
      },
    },
  }),
}));

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() {
        return tempDir;
      },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

async function findChatForDifferentVariant(mod: typeof import('../src/services/session-group-avatar.js'), firstChat: string): Promise<string> {
  const firstVariantId = mod.pickSessionGroupAvatarVariant(firstChat).id;
  let candidate = 'oc_session_beta';
  while (mod.pickSessionGroupAvatarVariant(candidate).id === firstVariantId) candidate += '_x';
  return candidate;
}

function clampByte(value: number): number {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function backgroundPixel(variant: { corners: readonly (readonly [number, number, number])[]; glow: readonly [number, number, number] }, x: number, y: number): [number, number, number, number] {
  const [topLeft, topRight, bottomLeft, bottomRight] = variant.corners;
  const [glowR, glowG, glowB] = variant.glow;
  const tx = x / (AVATAR_SIZE - 1);
  const ty = y / (AVATAR_SIZE - 1);

  const rowMixLeft = [
    mix(topLeft[0]!, bottomLeft[0]!, ty),
    mix(topLeft[1]!, bottomLeft[1]!, ty),
    mix(topLeft[2]!, bottomLeft[2]!, ty),
  ];
  const rowMixRight = [
    mix(topRight[0]!, bottomRight[0]!, ty),
    mix(topRight[1]!, bottomRight[1]!, ty),
    mix(topRight[2]!, bottomRight[2]!, ty),
  ];

  let r = mix(rowMixLeft[0]!, rowMixRight[0]!, tx);
  let g = mix(rowMixLeft[1]!, rowMixRight[1]!, tx);
  let b = mix(rowMixLeft[2]!, rowMixRight[2]!, tx);

  const glowDx = (x - 92) / 230;
  const glowDy = (y - 78) / 220;
  const glowStrength = Math.max(0, 1 - Math.sqrt(glowDx * glowDx + glowDy * glowDy));
  r = mix(r, glowR, glowStrength * 0.28);
  g = mix(g, glowG, glowStrength * 0.28);
  b = mix(b, glowB, glowStrength * 0.28);

  const maxDistance = Math.sqrt(0.5 ** 2 + 0.5 ** 2);
  const dx = tx - 0.5;
  const dy = ty - 0.5;
  const vignette = Math.max(0, Math.sqrt(dx * dx + dy * dy) / maxDistance - 0.2) / 0.8;
  const shade = 1 - vignette * 0.14;

  return [
    clampByte(r * shade),
    clampByte(g * shade),
    clampByte(b * shade),
    255,
  ];
}

function readPixel(data: Uint8Array, width: number, x: number, y: number): [number, number, number, number] {
  const index = (y * width + x) * 4;
  return [
    data[index]!,
    data[index + 1]!,
    data[index + 2]!,
    data[index + 3]!,
  ];
}

function blendExpected(
  background: readonly [number, number, number, number],
  source: readonly [number, number, number, number],
): [number, number, number, number] {
  const dstA = background[3] / 255;
  const srcA = source[3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  return [
    clampByte((source[0] * srcA + background[0] * dstA * (1 - srcA)) / outA),
    clampByte((source[1] * srcA + background[1] * dstA * (1 - srcA)) / outA),
    clampByte((source[2] * srcA + background[2] * dstA * (1 - srcA)) / outA),
    clampByte(outA * 255),
  ];
}

function pngFixtureChunk(type: string, payload: Uint8Array): Buffer {
  const bytes = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
    }
  }

  const result = Buffer.alloc(bytes.length + 8);
  result.writeUInt32BE(payload.length, 0);
  bytes.copy(result, 4);
  result.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

function rgbaPngFixture(width: number, height: number, compressed: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngFixtureChunk('IHDR', header),
    pngFixtureChunk('IDAT', compressed),
    pngFixtureChunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('session-group-avatar', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-avatar-test-'));
    nextImage = 1;
    imageCreateMock.mockClear();
    chatUpdateMock.mockClear();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('exposes exactly ten unique avatar variants', async () => {
    const mod = await import('../src/services/session-group-avatar.js');

    const ids = mod.SESSION_GROUP_AVATAR_VARIANTS.map((variant) => variant.id);
    expect(mod.SESSION_GROUP_AVATAR_VARIANTS).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it('keeps hash selection stable and reaches all ten variants', async () => {
    const mod = await import('../src/services/session-group-avatar.js');

    expect(mod.pickSessionGroupAvatarVariant('oc_session_alpha').id).toBe(
      mod.pickSessionGroupAvatarVariant('oc_session_alpha').id,
    );

    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      seen.add(mod.pickSessionGroupAvatarVariant(`oc_session_${i}`).id);
    }

    expect(seen).toEqual(new Set(mod.SESSION_GROUP_AVATAR_VARIANTS.map((variant) => variant.id)));
  });

  it('round-trips the inline logo PNG with the expected size and pixels intact', async () => {
    const mod = await import('../src/services/session-group-avatar.js');

    const logo = mod.decodeInlineSessionGroupLogo();
    expect(logo.width).toBe(LOGO_WIDTH);
    expect(logo.height).toBe(LOGO_HEIGHT);
    expect(logo.data).toHaveLength(LOGO_WIDTH * LOGO_HEIGHT * 4);
    expect(createHash('sha256').update(logo.data).digest('hex')).toBe(LOGO_RGBA_SHA256);

    const encoded = mod.encodePngRgba(logo.width, logo.height, logo.data);
    const decoded = mod.decodePngRgba(encoded);

    expect(decoded.width).toBe(LOGO_WIDTH);
    expect(decoded.height).toBe(LOGO_HEIGHT);
    expect(Array.from(decoded.data)).toEqual(Array.from(logo.data));
    expect(createHash('sha256').update(SESSION_GROUP_AVATAR_LOGO_BASE64).digest('hex')).toBe(LOGO_BASE64_SHA256);
    expect(createHash('sha256').update(Buffer.from(SESSION_GROUP_AVATAR_LOGO_BASE64, 'base64')).digest('hex')).toBe(LOGO_BYTES_SHA256);
  });

  it('decodes a fixed RGBA fixture with PNG filters 0 through 4', async () => {
    const mod = await import('../src/services/session-group-avatar.js');
    const filteredScanlines = Buffer.from([
      0, 10, 40, 90, 255, 200, 15, 230, 128, 5, 250, 60, 0,
      1, 30, 20, 240, 128, 234, 180, 66, 127, 242, 156, 211, 65,
      2, 220, 241, 36, 127, 52, 40, 150, 1, 86, 171, 225, 64,
      3, 142, 79, 141, 94, 206, 127, 192, 61, 157, 208, 107, 198,
      4, 179, 49, 29, 102, 104, 129, 139, 245, 17, 115, 102, 178,
    ]);
    const expectedRgba = new Uint8Array([
      10, 40, 90, 255, 200, 15, 230, 128, 5, 250, 60, 0,
      30, 20, 240, 128, 8, 200, 50, 255, 250, 100, 5, 64,
      250, 5, 20, 255, 60, 240, 200, 0, 80, 15, 230, 128,
      11, 81, 151, 221, 241, 31, 111, 171, 61, 231, 21, 91,
      190, 130, 180, 67, 89, 210, 34, 56, 78, 90, 123, 234,
    ]);

    const png = rgbaPngFixture(3, 5, deflateSync(filteredScanlines));
    expect(mod.decodePngRgba(png)).toEqual({ width: 3, height: 5, data: expectedRgba });
  });

  it('rejects oversized PNG dimensions before inflating IDAT', async () => {
    const mod = await import('../src/services/session-group-avatar.js');

    for (const [width, height] of [[6000, 6000], [4097, 4096], [4096, 4097], [1, 16777217]]) {
      const png = rgbaPngFixture(width!, height!, Buffer.from('invalid compressed payload'));
      expect(() => mod.decodePngRgba(png)).toThrow('PNG exceeds pixel limit (16777216)');
    }

    const atLimit = rgbaPngFixture(4096, 4096, deflateSync(Buffer.alloc(0)));
    expect(() => mod.decodePngRgba(atLimit)).toThrow('unexpected PNG payload size (0 !== 67112960)');
  });

  it('bounds inflate output even when IHDR claims a smaller image', async () => {
    const mod = await import('../src/services/session-group-avatar.js');
    const png = rgbaPngFixture(1, 1, deflateSync(Buffer.alloc(6)));

    expect(() => mod.decodePngRgba(png)).toThrow('Cannot create a Buffer larger than 5 bytes');
  });

  it('keeps straight-alpha logo edges free of a white matte', async () => {
    const mod = await import('../src/services/session-group-avatar.js');
    const { data } = mod.decodeInlineSessionGroupLogo();
    let semiTransparentPixels = 0;
    const channelTotals = [0, 0, 0];
    for (let offset = 0; offset < data.length; offset += 4) {
      const alpha = data[offset + 3]!;
      if (alpha === 0 || alpha === 255) continue;
      semiTransparentPixels += 1;
      for (let channel = 0; channel < 3; channel += 1) {
        channelTotals[channel] = channelTotals[channel]! + data[offset + channel]!;
      }
    }

    expect(semiTransparentPixels).toBe(3143);
    expect(channelTotals.map((total) => Math.round(total / semiTransparentPixels))).toEqual([143, 157, 245]);
  });

  it('renders logo pixels at the exact exported bounds and preserves background outside the logo', async () => {
    const mod = await import('../src/services/session-group-avatar.js');

    const firstVariant = mod.SESSION_GROUP_AVATAR_VARIANTS[0]!;
    const secondVariant = mod.SESSION_GROUP_AVATAR_VARIANTS[1]!;
    const bounds = mod.SESSION_GROUP_AVATAR_LOGO_BOUNDS;
    expect(bounds).toEqual({ x: 69, y: 86, width: 221, height: 187 });
    const logo = mod.decodeInlineSessionGroupLogo();
    const renderedFirst = mod.decodePngRgba(mod.renderSessionGroupAvatarPng(firstVariant));
    const renderedSecond = mod.decodePngRgba(mod.renderSessionGroupAvatarPng(secondVariant));

    const opaqueLogoPixel = readPixel(logo.data, logo.width, OPAQUE_SAMPLE.x, OPAQUE_SAMPLE.y);
    const edgeLogoPixel = readPixel(logo.data, logo.width, EDGE_SAMPLE.x, EDGE_SAMPLE.y);
    const transparentLogoPixel = readPixel(logo.data, logo.width, TRANSPARENT_SAMPLE.x, TRANSPARENT_SAMPLE.y);

    const opaqueX = bounds.x + OPAQUE_SAMPLE.x;
    const opaqueY = bounds.y + OPAQUE_SAMPLE.y;
    const edgeX = bounds.x + EDGE_SAMPLE.x;
    const edgeY = bounds.y + EDGE_SAMPLE.y;
    const transparentX = bounds.x + TRANSPARENT_SAMPLE.x;
    const transparentY = bounds.y + TRANSPARENT_SAMPLE.y;

    const opaqueRenderedPixel = readPixel(renderedFirst.data, renderedFirst.width, opaqueX, opaqueY);
    const edgeRenderedPixel = readPixel(renderedFirst.data, renderedFirst.width, edgeX, edgeY);
    const transparentRenderedPixel = readPixel(renderedFirst.data, renderedFirst.width, transparentX, transparentY);

    const opaqueBackgroundPixel = backgroundPixel(firstVariant, opaqueX, opaqueY);
    const edgeBackgroundPixel = backgroundPixel(firstVariant, edgeX, edgeY);
    const transparentBackgroundPixel = backgroundPixel(firstVariant, transparentX, transparentY);
    const edgeExpectedPixel = blendExpected(edgeBackgroundPixel, edgeLogoPixel);

    expect(opaqueLogoPixel[3]).toBe(255);
    expect(edgeLogoPixel[3]).toBeGreaterThan(0);
    expect(edgeLogoPixel[3]).toBeLessThan(255);
    expect(transparentLogoPixel[3]).toBe(0);

    expect(opaqueRenderedPixel).toEqual(opaqueLogoPixel);
    expect(opaqueRenderedPixel).not.toEqual(opaqueBackgroundPixel);

    expect(edgeRenderedPixel).toEqual(edgeExpectedPixel);
    expect(edgeRenderedPixel).not.toEqual(edgeBackgroundPixel);
    edgeRenderedPixel.forEach((channel, index) => {
      expect(Math.abs(channel - edgeExpectedPixel[index]!)).toBeLessThanOrEqual(1);
    });

    expect(transparentRenderedPixel).toEqual(transparentBackgroundPixel);

    const outerPointA = { x: 10, y: 10 };
    const outerPointB = { x: 350, y: 350 };
    const outerFirstA = readPixel(renderedFirst.data, renderedFirst.width, outerPointA.x, outerPointA.y);
    const outerSecondA = readPixel(renderedSecond.data, renderedSecond.width, outerPointA.x, outerPointA.y);
    const outerFirstB = readPixel(renderedFirst.data, renderedFirst.width, outerPointB.x, outerPointB.y);
    const outerSecondB = readPixel(renderedSecond.data, renderedSecond.width, outerPointB.x, outerPointB.y);

    expect(outerFirstA).toEqual(backgroundPixel(firstVariant, outerPointA.x, outerPointA.y));
    expect(outerFirstB).toEqual(backgroundPixel(firstVariant, outerPointB.x, outerPointB.y));
    expect(outerSecondA).toEqual(backgroundPixel(secondVariant, outerPointA.x, outerPointA.y));
    expect(outerSecondB).toEqual(backgroundPixel(secondVariant, outerPointB.x, outerPointB.y));
    expect(outerFirstA).not.toEqual(outerSecondA);
    expect(outerFirstB).not.toEqual(outerSecondB);
  });

  it('caches uploaded image keys by variant id', async () => {
    const mod = await import('../src/services/session-group-avatar.js');

    const firstChat = 'oc_session_alpha';
    const secondChat = await findChatForDifferentVariant(mod, firstChat);
    const firstVariantId = mod.pickSessionGroupAvatarVariant(firstChat).id;
    const secondVariantId = mod.pickSessionGroupAvatarVariant(secondChat).id;

    await mod.applySessionGroupAvatar(APP, firstChat);
    await mod.applySessionGroupAvatar(APP, firstChat);
    await mod.applySessionGroupAvatar(APP, secondChat);

    expect(imageCreateMock).toHaveBeenCalledTimes(2);
    expect(chatUpdateMock).toHaveBeenCalledTimes(3);
    expect(chatUpdateMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: { avatar: 'img_1' } }));
    expect(chatUpdateMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: { avatar: 'img_1' } }));
    expect(chatUpdateMock).toHaveBeenNthCalledWith(3, expect.objectContaining({ data: { avatar: 'img_2' } }));

    const cache = JSON.parse(readFileSync(join(tempDir, `session-avatar-cache-${APP}.json`), 'utf-8'));
    expect(cache.imageKeys).toMatchObject({
      [firstVariantId]: 'img_1',
      [secondVariantId]: 'img_2',
    });
  });
});
