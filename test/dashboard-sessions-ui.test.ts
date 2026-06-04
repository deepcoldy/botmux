import { describe, expect, it } from 'vitest';
import { renderCliFilterGroup } from '../src/dashboard/web/sessions.js';

describe('dashboard sessions filters', () => {
  it('renders CLI filters as same-name checkboxes checked by default for multi-select filtering', () => {
    const html = renderCliFilterGroup();

    expect(html).toContain('type="checkbox"');
    expect(html).toContain('name="cli"');
    expect(html).toContain('value="codex"');
    expect(html).toContain('value="pi"');
    expect(html).toMatch(/value="codex" checked/);
    expect(html).toMatch(/value="pi" checked/);
    expect(html).not.toContain('<select');
  });
});
