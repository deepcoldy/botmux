/**
 * Default icon for Feishu apps created by botmux (setup / Dashboard onboarding).
 *
 * Reuses the session-group avatar look — botmux logo on one of the ten
 * gradients, picked at random per app — but at the 512×512 the Open Platform
 * icon upload declares (see AVATAR_IMAGE_SIZE in open-platform-rename.ts).
 *
 * The 360px group avatar composites a 221×187 logo resized offline; scaling
 * that up would blur it. So the 512px logo is derived from the same 512px
 * favicon the offline logo was cut from, via the same steps: un-matte, crop
 * 404x344+54+84, Lanczos resize (test/bot-app-icon.test.ts cross-checks the
 * pipeline against the committed 221×187 logo).
 */
import { randomInt } from 'node:crypto';
import { BOTMUX_APP_ICON_BASE64 } from '../setup/app-icon-data.js';
import {
  SESSION_GROUP_AVATAR_VARIANTS,
  decodePngRgba,
  renderLogoAvatarPng,
  type AvatarVariant,
  type DecodedPng,
} from './session-group-avatar.js';

export const BOT_APP_ICON_SIZE = 512;
// The group avatar's 221×187 logo on 360px, scaled to the 512px canvas.
export const BOT_APP_ICON_LOGO_WIDTH = 314;
export const BOT_APP_ICON_LOGO_HEIGHT = 266;

const FAVICON_LOGO_CROP = { x: 54, y: 84, width: 404, height: 344 } as const;
const LANCZOS_LOBES = 3;

interface Taps {
  first: number;
  weights: number[];
}

function lanczos(x: number): number {
  if (x === 0) return 1;
  if (x <= -LANCZOS_LOBES || x >= LANCZOS_LOBES) return 0;
  const px = Math.PI * x;
  return (LANCZOS_LOBES * Math.sin(px) * Math.sin(px / LANCZOS_LOBES)) / (px * px);
}

/** Normalized taps mapping source span [start, start + length) onto `outSize` pixels (Pillow's convention). */
function resampleTaps(sourceSize: number, start: number, length: number, outSize: number): Taps[] {
  const scale = length / outSize;
  const filterScale = Math.max(scale, 1);
  const support = LANCZOS_LOBES * filterScale;
  const taps: Taps[] = [];
  for (let i = 0; i < outSize; i += 1) {
    const center = start + (i + 0.5) * scale;
    const first = Math.max(0, Math.floor(center - support + 0.5));
    const end = Math.min(sourceSize, Math.floor(center + support + 0.5));
    const weights: number[] = [];
    let total = 0;
    for (let x = first; x < end; x += 1) {
      const weight = lanczos((x - center + 0.5) / filterScale);
      weights.push(weight);
      total += weight;
    }
    taps.push({ first, weights: weights.map((weight) => weight / total) });
  }
  return taps;
}

/**
 * The favicon is white-matted: an edge pixel of color C and alpha a is stored
 * as C·a + 255·(1−a). Peel the matte straight into premultiplied form
 * (C·a = P − (255 − alpha)), which resampling needs anyway so transparent
 * pixels do not bleed color into the edges.
 */
function unmattePremultiplied(png: DecodedPng): Float64Array {
  const out = new Float64Array(png.data.length);
  for (let i = 0; i < png.data.length; i += 4) {
    const alpha = png.data[i + 3]!;
    for (let c = 0; c < 3; c += 1) {
      out[i + c] = Math.min(Math.max(png.data[i + c]! - (255 - alpha), 0), alpha);
    }
    out[i + 3] = alpha;
  }
  return out;
}

function resample(
  source: Float64Array,
  sourceWidth: number,
  sourceHeight: number,
  crop: typeof FAVICON_LOGO_CROP,
  width: number,
  height: number,
): Float64Array {
  const columns = resampleTaps(sourceWidth, crop.x, crop.width, width);
  const rows = resampleTaps(sourceHeight, crop.y, crop.height, height);

  const horizontal = new Float64Array(width * sourceHeight * 4);
  for (let y = 0; y < sourceHeight; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const { first, weights } = columns[x]!;
      for (let c = 0; c < 4; c += 1) {
        let sum = 0;
        for (let k = 0; k < weights.length; k += 1) {
          sum += source[(y * sourceWidth + first + k) * 4 + c]! * weights[k]!;
        }
        horizontal[(y * width + x) * 4 + c] = sum;
      }
    }
  }

  const out = new Float64Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const { first, weights } = rows[y]!;
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let sum = 0;
        for (let k = 0; k < weights.length; k += 1) {
          sum += horizontal[((first + k) * width + x) * 4 + c]! * weights[k]!;
        }
        out[(y * width + x) * 4 + c] = sum;
      }
    }
  }
  return out;
}

function toStraightRgba(premultiplied: Float64Array): Uint8Array {
  const out = new Uint8Array(premultiplied.length);
  for (let i = 0; i < premultiplied.length; i += 4) {
    // Lanczos lobes overshoot past [0, 255]; clamp before un-premultiplying.
    const alpha = Math.min(Math.max(premultiplied[i + 3]!, 0), 255);
    out[i + 3] = Math.round(alpha);
    if (out[i + 3] === 0) continue;
    for (let c = 0; c < 3; c += 1) {
      out[i + c] = Math.min(Math.max(Math.round((premultiplied[i + c]! * 255) / alpha), 0), 255);
    }
  }
  return out;
}

/** The favicon's logo, un-matted and Lanczos-resized to `width`×`height` straight RGBA. */
export function deriveLogoFromFavicon(width: number, height: number): DecodedPng {
  const favicon = decodePngRgba(Buffer.from(BOTMUX_APP_ICON_BASE64, 'base64'));
  const premultiplied = resample(
    unmattePremultiplied(favicon),
    favicon.width,
    favicon.height,
    FAVICON_LOGO_CROP,
    width,
    height,
  );
  return { width, height, data: toStraightRgba(premultiplied) };
}

export function pickRandomBotAppIconVariant(): AvatarVariant {
  return SESSION_GROUP_AVATAR_VARIANTS[randomInt(SESSION_GROUP_AVATAR_VARIANTS.length)]!;
}

/** 512×512 PNG: `variant`'s gradient (random by default) with the botmux logo. */
export function renderBotAppIconPng(variant: AvatarVariant = pickRandomBotAppIconVariant()): Buffer {
  const logo = deriveLogoFromFavicon(BOT_APP_ICON_LOGO_WIDTH, BOT_APP_ICON_LOGO_HEIGHT);
  return renderLogoAvatarPng(variant, BOT_APP_ICON_SIZE, logo);
}
