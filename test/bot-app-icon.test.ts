import { describe, expect, it } from 'vitest';
import {
  BOT_APP_ICON_LOGO_HEIGHT,
  BOT_APP_ICON_LOGO_WIDTH,
  BOT_APP_ICON_SIZE,
  deriveLogoFromFavicon,
  pickRandomBotAppIconVariant,
  renderBotAppIconPng,
} from '../src/services/bot-app-icon.js';
import {
  SESSION_GROUP_AVATAR_LOGO_BOUNDS,
  SESSION_GROUP_AVATAR_VARIANTS,
  decodeInlineSessionGroupLogo,
  decodePngRgba,
  renderSessionGroupAvatarPng,
} from '../src/services/session-group-avatar.js';
import { AVATAR_IMAGE_SIZE, validateAvatarPng } from '../src/services/open-platform-rename.js';

const GROUP_AVATAR_SIZE = 360;

function readPixel(data: Uint8Array, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return Array.from(data.subarray(offset, offset + 4));
}

describe('bot-app-icon', () => {
  it('derives the logo through the same pipeline that produced the committed group-avatar logo', () => {
    // The inline 221×187 logo was cut from the favicon offline (un-matte, crop,
    // PIL LANCZOS). Running our runtime pipeline at that size must land on it,
    // which is what lets the 512px icon use a sharp logo instead of an upscale.
    const derived = deriveLogoFromFavicon(SESSION_GROUP_AVATAR_LOGO_BOUNDS.width, SESSION_GROUP_AVATAR_LOGO_BOUNDS.height);
    const committed = decodeInlineSessionGroupLogo();
    expect(derived.data).toHaveLength(committed.data.length);

    let alphaDiffTotal = 0;
    let alphaDiffMax = 0;
    let opaqueColorDiffMax = 0;
    for (let offset = 0; offset < committed.data.length; offset += 4) {
      const alphaDiff = Math.abs(derived.data[offset + 3]! - committed.data[offset + 3]!);
      alphaDiffTotal += alphaDiff;
      alphaDiffMax = Math.max(alphaDiffMax, alphaDiff);
      if (committed.data[offset + 3] !== 255) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        opaqueColorDiffMax = Math.max(
          opaqueColorDiffMax,
          Math.abs(derived.data[offset + channel]! - committed.data[offset + channel]!),
        );
      }
    }
    // Residue is Pillow's 8-bit fixed-point arithmetic vs our float math.
    expect(alphaDiffTotal / (committed.data.length / 4)).toBeLessThan(0.5);
    expect(alphaDiffMax).toBeLessThanOrEqual(16);
    expect(opaqueColorDiffMax).toBeLessThanOrEqual(8);
  });

  it('scales the group-avatar logo proportionally onto the 512px canvas', () => {
    const scale = BOT_APP_ICON_SIZE / GROUP_AVATAR_SIZE;
    expect(BOT_APP_ICON_SIZE).toBe(AVATAR_IMAGE_SIZE);
    expect(BOT_APP_ICON_LOGO_WIDTH).toBe(Math.round(SESSION_GROUP_AVATAR_LOGO_BOUNDS.width * scale));
    expect(BOT_APP_ICON_LOGO_HEIGHT).toBe(Math.round(SESSION_GROUP_AVATAR_LOGO_BOUNDS.height * scale));
  });

  it('renders a 512×512 PNG the Open Platform icon upload accepts, logo centered and composited 1:1', () => {
    const variant = SESSION_GROUP_AVATAR_VARIANTS[0]!;
    const png = renderBotAppIconPng(variant);
    expect(validateAvatarPng(png)).toEqual({ ok: true });

    const rendered = decodePngRgba(png);
    expect(rendered.width).toBe(BOT_APP_ICON_SIZE);
    expect(rendered.height).toBe(BOT_APP_ICON_SIZE);

    const logo = deriveLogoFromFavicon(BOT_APP_ICON_LOGO_WIDTH, BOT_APP_ICON_LOGO_HEIGHT);
    const left = (BOT_APP_ICON_SIZE - BOT_APP_ICON_LOGO_WIDTH) / 2;
    const top = (BOT_APP_ICON_SIZE - BOT_APP_ICON_LOGO_HEIGHT) / 2;
    let opaquePixels = 0;
    for (let y = 0; y < logo.height; y += 1) {
      for (let x = 0; x < logo.width; x += 1) {
        const logoPixel = readPixel(logo.data, logo.width, x, y);
        if (logoPixel[3] !== 255) continue;
        opaquePixels += 1;
        expect(readPixel(rendered.data, rendered.width, left + x, top + y)).toEqual(logoPixel);
      }
    }
    expect(opaquePixels).toBeGreaterThan(10_000);
  });

  it('keeps each variant\'s group-avatar background, just at 512px', () => {
    const last = BOT_APP_ICON_SIZE - 1;
    const groupLast = GROUP_AVATAR_SIZE - 1;
    const samples = [
      [0, 0, 0, 0],
      [last, 0, groupLast, 0],
      [0, last, 0, groupLast],
      [last, last, groupLast, groupLast],
    ] as const;
    for (const variant of SESSION_GROUP_AVATAR_VARIANTS) {
      const icon = decodePngRgba(renderBotAppIconPng(variant));
      const group = decodePngRgba(renderSessionGroupAvatarPng(variant));
      for (const [x, y, groupX, groupY] of samples) {
        const iconPixel = readPixel(icon.data, icon.width, x, y);
        const groupPixel = readPixel(group.data, group.width, groupX, groupY);
        iconPixel.forEach((channel, index) => {
          expect(Math.abs(channel - groupPixel[index]!), `${variant.id} @${x},${y}`).toBeLessThanOrEqual(1);
        });
      }
    }
  });

  it('picks among all ten variants at random by default', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(pickRandomBotAppIconVariant().id);
    expect(seen).toEqual(new Set(SESSION_GROUP_AVATAR_VARIANTS.map((variant) => variant.id)));

    const corners = new Set(
      SESSION_GROUP_AVATAR_VARIANTS.map((variant) => {
        const group = decodePngRgba(renderSessionGroupAvatarPng(variant));
        return readPixel(group.data, group.width, 0, 0).join(',');
      }),
    );
    const icon = decodePngRgba(renderBotAppIconPng());
    expect(corners.has(readPixel(icon.data, icon.width, 0, 0).join(','))).toBe(true);
  });
});
