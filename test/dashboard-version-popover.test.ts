import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

function dashboardSource(file: string): string {
  return readFileSync(new URL(`../src/dashboard/web/${file}`, import.meta.url), 'utf8');
}

describe('dashboard version popover layering regression', () => {
  it('portals the popover out of the app stacking context and keeps its position tied to the trigger', () => {
    const app = dashboardSource('app.tsx');
    const css = dashboardSource('style.css');

    expect(app).toContain("createPortal((");
    expect(app).toContain('document.body');
    expect(app).toContain('trigger.getBoundingClientRect()');
    expect(app).toContain("document.addEventListener('scroll', updatePopoverPosition, true)");
    expect(app).toContain('popoverRef.current?.contains(target)');
    expect(app).toContain('firstFocusable?.focus()');
    expect(app).toContain('window.requestAnimationFrame');
    expect(css).toMatch(/\.dashboard-version-popover\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*1601;/);
    expect(css).toMatch(/\.dashboard-version-control\s*\{[\s\S]*?z-index:\s*2;/);
  });

  it('clamps the portal horizontally instead of relying on the old topbar offset', () => {
    const app = dashboardSource('app.tsx');
    const css = dashboardSource('style.css');

    expect(app).toContain('window.innerWidth - maxWidth - 16');
    expect(css).not.toMatch(/\.dashboard-version-popover\s*\{[^}]*left:\s*-33px;/s);
  });
});
