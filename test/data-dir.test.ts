import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveBotmuxDataDir } from '../src/core/data-dir.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'botmux-data-dir-'));
  roots.push(value);
  return value;
}

describe('resolveBotmuxDataDir', () => {
  it('uses one env -> breadcrumb -> stable user fallback precedence', () => {
    const home = root();
    const explicit = join(home, 'explicit');
    const active = join(home, 'active');
    mkdirSync(explicit);
    mkdirSync(active);
    mkdirSync(join(home, '.botmux'));
    writeFileSync(join(home, '.botmux', '.data-dir'), active, 'utf-8');

    expect(resolveBotmuxDataDir({ env: { HOME: home, SESSION_DATA_DIR: explicit } })).toBe(explicit);
    expect(resolveBotmuxDataDir({ env: { HOME: home } })).toBe(active);
    rmSync(active, { recursive: true });
    expect(resolveBotmuxDataDir({ env: { HOME: home } })).toBe(join(home, '.botmux', 'data'));
  });

  it('does not follow a symlinked or relative breadcrumb', () => {
    const home = root();
    const configDir = join(home, '.botmux');
    const target = join(home, 'target');
    mkdirSync(configDir);
    mkdirSync(target);
    const realBreadcrumb = join(home, 'breadcrumb');
    writeFileSync(realBreadcrumb, target, 'utf-8');
    symlinkSync(realBreadcrumb, join(configDir, '.data-dir'));
    expect(resolveBotmuxDataDir({ env: { HOME: home } })).toBe(join(configDir, 'data'));

    rmSync(join(configDir, '.data-dir'));
    writeFileSync(join(configDir, '.data-dir'), '../relative', 'utf-8');
    expect(resolveBotmuxDataDir({ env: { HOME: home } })).toBe(join(configDir, 'data'));
  });
});
