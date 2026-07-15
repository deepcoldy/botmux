import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

describe('dashboard mobile layout', () => {
  it('keeps the top navigation rail inside the viewport with native horizontal touch scrolling', () => {
    expect(css).toMatch(/@media \(max-width: 980px\)[\s\S]*?\.chrome-body\s*\{\s*gap:\s*0;/);
    expect(css).toMatch(/@media \(max-width: 980px\)[\s\S]*?\.sidebar\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/);
    expect(css).toMatch(/@media \(max-width: 980px\)[\s\S]*?\.sidebar-nav\s*\{[\s\S]*?width:\s*100%;[\s\S]*?touch-action:\s*pan-x;[\s\S]*?overflow-scrolling:\s*touch;/);
  });

  it('returns sessions and groups pages to the main mobile vertical scroller', () => {
    expect(css).toMatch(/main:has\(\.sessions-page\),\s*main:has\(\.groups-page\)\s*\{[\s\S]*?overflow-y:\s*auto;[\s\S]*?overflow-scrolling:\s*touch;/);
    expect(css).toMatch(/main:has\(\.sessions-page\) \.sessions-page\s*\{[\s\S]*?height:\s*auto;[\s\S]*?overflow:\s*visible;/);
    expect(css).toMatch(/main:has\(\.groups-page\) \.groups-page\s*\{[\s\S]*?height:\s*auto;[\s\S]*?overflow:\s*visible;/);
  });

  it('keeps the sessions view switch and bulk actions readable at phone widths', () => {
    expect(css).toMatch(/main:has\(\.sessions-page\) \.sessions-view-toggle\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);[\s\S]*?width:\s*100%;/);
    expect(css).toMatch(/main:has\(\.sessions-page\) \.sessions-view-toggle button\s*\{[\s\S]*?white-space:\s*nowrap;/);
    expect(css).toMatch(/main:has\(\.sessions-page\) \.bulk-bar\s*\{[\s\S]*?top:\s*-16px;[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
    expect(css).toMatch(/\.bulk-bar\s*\{[\s\S]*?--bulk-bar-bg:\s*color-mix\(in srgb,\s*var\(--warning\) 10%,\s*var\(--bg\)\);[\s\S]*?background:\s*var\(--bulk-bar-bg\);/);
    expect(css).toMatch(/main:has\(\.sessions-page\) \.bulk-bar\s*\{[\s\S]*?box-shadow:\s*0 0 0 16px var\(--bulk-bar-bg\),\s*var\(--shadow\);/);
    expect(css).toMatch(/main:has\(\.sessions-page\) \.bulk-bar\[hidden\]\s*\{\s*display:\s*none;/);
    expect(css).toMatch(/main:has\(\.sessions-page\) \.bulk-bar button\s*\{[\s\S]*?white-space:\s*nowrap;/);
  });
});
