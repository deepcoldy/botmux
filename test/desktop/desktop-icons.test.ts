import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('Desktop icons', () => {
  it('derives every Desktop icon from the Dashboard favicon', () => {
    const script = readFileSync(resolve(root, 'scripts/build-desktop-icons.mjs'), 'utf8');

    expect(script).toContain("'src', 'dashboard', 'web', 'favicon.png'");
    expect(script).toContain("join(root, 'build', 'icon.png')");
    expect(script).toContain("join(root, 'src', 'desktop', 'assets', 'trayTemplate.png')");
    expect(script).toContain("join(root, 'src', 'desktop', 'assets', 'trayTemplate@2x.png')");
    expect(existsSync(resolve(root, 'build/icon.svg'))).toBe(false);
    expect(existsSync(resolve(root, 'build/tray-template.svg'))).toBe(false);
  });
});
