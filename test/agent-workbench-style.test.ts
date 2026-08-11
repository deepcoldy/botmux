import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Agent Workbench visual contract', () => {
  const css = readFileSync(join(process.cwd(), 'src/dashboard/web/style.css'), 'utf8');
  const block = css.slice(css.indexOf('/* Agent Workbench'));

  it('has semantic dark/light tokens and no gradients', () => {
    expect(block).toContain('--wb-bg: #080b10');
    expect(block).toContain(':root[data-theme="light"] .agent-workbench-page');
    expect(block).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
  });

  it('keeps explicit pixel radii at or below 4px', () => {
    const radii = [...block.matchAll(/border-radius:\s*(\d+)px/g)].map(match => Number(match[1]));
    expect(radii.length).toBeGreaterThanOrEqual(8);
    expect(Math.max(...radii)).toBeLessThanOrEqual(4);
  });

  it('keeps the H5 login and Preview guard flat as part of the same UI contract', () => {
    for (const relative of ['src/dashboard/h5-auth.ts', 'src/dashboard/preview-guard-page.ts']) {
      const source = readFileSync(join(process.cwd(), relative), 'utf8');
      const radii = [...source.matchAll(/border-radius:\s*(\d+)px/g)].map(match => Number(match[1]));
      expect(radii.length, relative).toBeGreaterThan(0);
      expect(Math.max(...radii), relative).toBeLessThanOrEqual(4);
      expect(source, relative).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    }
  });

  it('contains non-color state text and reduced-motion handling', () => {
    expect(block).toContain('.wb-mode-chip');
    expect(block).toContain('.wb-chat-contract');
    expect(block).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
