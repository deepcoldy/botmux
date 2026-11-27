import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => {
    const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function themeTokens(css: string, selector: string) {
  const theme = css.split(`${selector} {`)[1]?.split('}')[0] ?? '';
  return new Map([...theme.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})\s*;/gi)]
    .map(([, name, color]) => [name, color]));
}

function contrastRatio(first: string, second: string): number {
  const colors = [luminance(first), luminance(second)];
  return (Math.max(...colors) + 0.05) / (Math.min(...colors) + 0.05);
}

// 源码结构护栏(K4)：对 CSS 颜色令牌的实际配对计算 WCAG 对比度，避免在测试中另抄色值。
it('keeps the filled primary action at WCAG AA contrast in both appearances', () => {
  const css = readFileSync(new URL('../src/dashboard/web/design-tokens.css', import.meta.url), 'utf8');
  for (const selector of [':root', ':root[data-theme="dark"]']) {
    const tokens = themeTokens(css, selector);
    const fill = tokens.get('--accent-fill');
    const foreground = tokens.get('--on-accent');
    if (!fill || !foreground) throw new Error(`Missing primary action color pair for ${selector}`);

    expect(contrastRatio(fill, foreground), selector).toBeGreaterThanOrEqual(4.5);
  }
});

// 源码结构护栏(K4)：验证实际令牌定义的表面亮度顺序及实色回退下的导航文字对比度。
it('keeps the sidebar and card surfaces distinct from the canvas in both appearances', () => {
  const css = readFileSync(new URL('../src/dashboard/web/design-tokens.css', import.meta.url), 'utf8');
  for (const selector of [':root', ':root[data-theme="dark"]']) {
    const tokens = themeTokens(css, selector);
    const sidebar = tokens.get('--mat-sidebar-solid-bg');
    const canvas = tokens.get('--bg');
    const card = tokens.get('--surface');
    const foreground = tokens.get('--muted');
    if (!sidebar || !canvas || !card || !foreground) throw new Error(`Missing surface or text color for ${selector}`);

    expect(contrastRatio(sidebar, foreground), selector).toBeGreaterThanOrEqual(4.5);
    expect(luminance(card), selector).toBeGreaterThan(luminance(canvas));
    expect(luminance(sidebar), selector).toBeGreaterThan(luminance(canvas));
    if (selector !== ':root') expect(luminance(sidebar), selector).toBeGreaterThan(luminance(card));
  }
});
