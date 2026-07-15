import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../src/dashboard/web/app.tsx', import.meta.url), 'utf8');
const themeMenu = readFileSync(new URL('../src/dashboard/web/theme-menu.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

describe('dashboard mobile topbar menus', () => {
  it('uses an explicit click-toggle state for the session overview menu', () => {
    expect(app).toContain("${open ? ' is-open' : ''}");
    expect(app).toContain('aria-expanded={visible}');
    expect(app).toContain('onClick={toggle}');
    expect(app).toContain("${hoverSuppressed ? ' suppress-hover' : ''}");
    expect(app).toContain('onPointerLeave={() => setHoverSuppressed(false)}');
    expect(css).toContain('.topbar-status-menu.is-open .topbar-status-pop');
    expect(css).toContain('.topbar-status-menu:not(.suppress-hover):hover .topbar-status-pop');
    expect(css).not.toContain('.topbar-status-menu:focus-within .topbar-status-pop');
  });

  it('does not run hover close/open behavior for touch pointers', () => {
    expect(themeMenu).toContain("if (event.pointerType === 'touch') return;");
    expect(themeMenu).toContain("btn.addEventListener('click', event => {");
    expect(themeMenu).toContain('setOpen(!open);');
    expect(themeMenu).toContain("if (!open || e.pointerType === 'touch') return;");
  });
});
