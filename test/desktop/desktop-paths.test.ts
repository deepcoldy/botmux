import { describe, expect, it } from 'vitest';
import { resolveDesktopPaths } from '../../src/desktop/main/paths.js';

describe('desktop paths', () => {
  it('uses ~/.botmux as Botmux Home by default', () => {
    const paths = resolveDesktopPaths({
      homeDir: '/Users/alice',
      userDataDir: '/Users/alice/Library/Application Support/Botmux',
      resourcesPath: '/Applications/Botmux.app/Contents/Resources',
      appVersion: '1.2.3',
      isPackaged: true,
    });

    expect(paths.botmuxHome).toBe('/Users/alice/.botmux');
    expect(paths.logsDir).toBe('/Users/alice/.botmux/logs');
    expect(paths.pm2Home).toBe('/Users/alice/.botmux/pm2');
  });

  it('does not create app-owned runtime paths in packaged builds', () => {
    const paths = resolveDesktopPaths({
      homeDir: '/Users/alice',
      userDataDir: '/Users/alice/Library/Application Support/Botmux',
      resourcesPath: '/Applications/Botmux.app/Contents/Resources',
      appVersion: '1.2.3',
      isPackaged: true,
    });

    expect(Object.keys(paths).sort()).toEqual([
      'botmuxHome',
      'dataDir',
      'logsDir',
      'pm2Home',
    ]);
  });

  it('uses the same shared state paths in development', () => {
    const paths = resolveDesktopPaths({
      homeDir: '/Users/alice',
      userDataDir: '/Users/alice/Library/Application Support/Botmux',
      resourcesPath: '/repo',
      appVersion: '0.0.0-dev',
      isPackaged: false,
      devRepoRoot: '/repo',
    });

    expect(paths.botmuxHome).toBe('/Users/alice/.botmux');
    expect(paths.dataDir).toBe('/Users/alice/.botmux/data');
  });
});
