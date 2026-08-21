import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BROWSER_TARGETS,
  resolveBrowserTargets,
  formatBrowserLabel,
  restartBrowser,
} from '../src/core/browser-restart.js';

describe('resolveBrowserTargets — configurable, never hard-coded', () => {
  it('returns the built-in Arc/Chrome/Edge defaults when config is empty/undefined', () => {
    const ids = resolveBrowserTargets(undefined).map(t => t.bundleId);
    expect(ids).toEqual(DEFAULT_BROWSER_TARGETS.map(t => t.bundleId));
    expect(resolveBrowserTargets([]).map(t => t.label)).toEqual(['Arc', 'Chrome', 'Edge']);
  });

  it('overrides an existing default by bundleId (label/openArgs) without dropping others', () => {
    const out = resolveBrowserTargets([
      { bundleId: 'company.thebrowser.Browser', label: 'Arc 浏览器', openArgs: ['--foo'] },
    ]);
    const arc = out.find(t => t.bundleId === 'company.thebrowser.Browser')!;
    expect(arc.label).toBe('Arc 浏览器');
    expect(arc.openArgs).toEqual(['--foo']);
    // Chrome + Edge still present + unchanged.
    expect(out.map(t => t.bundleId)).toContain('com.google.Chrome');
    expect(out.map(t => t.bundleId)).toContain('com.microsoft.edgemac');
  });

  it('appends a brand-new browser with no code change', () => {
    const out = resolveBrowserTargets([
      { bundleId: 'com.brave.Browser', label: 'Brave' },
    ]);
    expect(out.find(t => t.bundleId === 'com.brave.Browser')?.label).toBe('Brave');
    expect(out).toHaveLength(4);
  });

  it('drops a default when config disables it (enabled:false)', () => {
    const out = resolveBrowserTargets([{ bundleId: 'com.microsoft.edgemac', enabled: false }]);
    expect(out.map(t => t.bundleId)).not.toContain('com.microsoft.edgemac');
    expect(out.map(t => t.bundleId)).toContain('company.thebrowser.Browser');
  });

  it('ignores garbage entries (missing/blank bundleId, non-objects)', () => {
    const out = resolveBrowserTargets(['nope', 42, {}, { bundleId: '   ' }, null]);
    expect(out.map(t => t.bundleId)).toEqual(DEFAULT_BROWSER_TARGETS.map(t => t.bundleId));
  });
});

describe('formatBrowserLabel', () => {
  it('renders GB for >= 1024 MB and MB otherwise', () => {
    expect(formatBrowserLabel('Arc', 6202)).toBe('♻️ 重启 Arc · 6.1 GB');
    expect(formatBrowserLabel('Chrome', 512)).toBe('♻️ 重启 Chrome · 512 MB');
  });
  it('omits the memory suffix when unknown/zero', () => {
    expect(formatBrowserLabel('Edge')).toBe('♻️ 重启 Edge');
    expect(formatBrowserLabel('Edge', 0)).toBe('♻️ 重启 Edge');
  });
});

describe('restartBrowser — bundleId quit + relaunch, never force-kill', () => {
  it('quits, waits for exit, then relaunches with openArgs', async () => {
    const calls: Array<[string, string[]]> = [];
    let alive = true;
    const result = await restartBrowser(
      { bundleId: 'com.google.Chrome', openArgs: ['--restore-last-session'] },
      {
        run: async (file, args) => { calls.push([file, args]); return { stdout: '' }; },
        isRunning: async () => alive,
        sleep: async () => { alive = false; }, // process exits after first poll
        now: (() => { let t = 0; return () => (t += 100); })(),
      },
    );
    expect(result).toEqual({ ok: true, quit: true, relaunched: true });
    expect(calls[0][0]).toBe('osascript');
    expect(calls[0][1].join(' ')).toContain('id "com.google.Chrome" to quit');
    const open = calls.find(c => c[0] === 'open')!;
    expect(open[1]).toEqual(['-b', 'com.google.Chrome', '--args', '--restore-last-session']);
  });

  it('does NOT relaunch (and reports) when the browser refuses to quit within the window', async () => {
    const calls: Array<[string, string[]]> = [];
    const result = await restartBrowser(
      { bundleId: 'company.thebrowser.Browser' },
      {
        run: async (file, args) => { calls.push([file, args]); return { stdout: '' }; },
        isRunning: async () => true, // never exits (unsaved dialog)
        sleep: async () => {},
        now: (() => { let t = 0; return () => (t += 5_000); })(),
        quitTimeoutMs: 12_000,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.relaunched).toBe(false);
    expect(calls.some(c => c[0] === 'open')).toBe(false); // never relaunched
    expect(calls.some(c => c[1].includes('-9') || c[1].includes('kill'))).toBe(false); // never force-killed
  });

  it('reports quit-failure without relaunching', async () => {
    const result = await restartBrowser(
      { bundleId: 'x.y.z' },
      { run: async () => { throw new Error('no such app'); }, isRunning: async () => false, sleep: async () => {} },
    );
    expect(result.ok).toBe(false);
    expect(result.quit).toBe(false);
    expect(result.error).toContain('quit failed');
  });
});

import { detectRunningBrowsers, commandInApp } from '../src/core/browser-restart.js';

describe('commandInApp — executable left-boundary match', () => {
  const app = '/Applications/Arc.app';
  it('matches when the executable (argv0) is under the bundle', () => {
    expect(commandInApp(`${app}/Contents/MacOS/Arc`, app)).toBe(true);
    expect(commandInApp(`  ${app}/Contents/Frameworks/Helper --type=gpu`, app)).toBe(true);
  });
  it('matches when argv0 is exactly the app path (with or without following args)', () => {
    expect(commandInApp(app, app)).toBe(true);
    expect(commandInApp(`${app} --new-window`, app)).toBe(true);
  });
  it('does NOT match when the path is an unrelated ARGUMENT (not argv0)', () => {
    // e.g. `open -b x /Applications/Arc.app` launches via LaunchServices; the
    // executable is /usr/bin/open, not Arc — must not be counted as Arc running.
    expect(commandInApp(`/usr/bin/open -b x ${app}`, app)).toBe(false);
  });
  it('does NOT match a "-copy" sibling or a substring inside an arg', () => {
    expect(commandInApp(`${app}-copy/Contents/MacOS/Arc`, app)).toBe(false);
    expect(commandInApp(`/usr/bin/foo --flag=${app}bar`, app)).toBe(false);
  });
  it('does NOT match a backup copy launched from another root (left-prefix)', () => {
    expect(commandInApp(`/Volumes/Backup/Applications/Arc.app/Contents/MacOS/Arc`, app)).toBe(false);
    expect(commandInApp(`/Users/x/Backups${app}/Contents/MacOS/Arc`, app)).toBe(false);
  });
});

describe('detectRunningBrowsers — DI probe, boundary aware + non-darwin', () => {
  const appPath = '/Applications/Arc.app';
  const psText = [
    `  100000 ${appPath}/Contents/MacOS/Arc`,
    `  200000 ${appPath}/Contents/Frameworks/Helper`,
    `  999999 ${appPath}-copy/Contents/MacOS/Arc`,
    `  888888 /usr/bin/foo --flag=${appPath}bar`,
  ].join('\n');

  it('sums only processes under the exact bundle path', async () => {
    const out = await detectRunningBrowsers(
      [{ bundleId: 'company.thebrowser.Browser', label: 'Arc' }],
      { platform: 'darwin', psList: async () => psText, appPathFor: async () => appPath },
    );
    expect(out).toHaveLength(1);
    expect(out[0].memMB).toBe(Math.round(300000 / 1024)); // -copy + substring excluded
  });

  it('omits a browser that is installed but not running (0 MB)', async () => {
    const out = await detectRunningBrowsers(
      [{ bundleId: 'x', label: 'X' }],
      { platform: 'darwin', psList: async () => '  1234 /usr/bin/other', appPathFor: async () => '/Applications/X.app' },
    );
    expect(out).toEqual([]);
  });

  it('returns [] on non-darwin without probing', async () => {
    let probed = false;
    const out = await detectRunningBrowsers(
      [{ bundleId: 'x', label: 'X' }],
      { platform: 'linux', psList: async () => { probed = true; return ''; }, appPathFor: async () => { probed = true; return ''; } },
    );
    expect(out).toEqual([]);
    expect(probed).toBe(false);
  });
});

describe('restartBrowser — default liveness probe is fail-safe (never blind relaunch)', () => {
  it('treats an unresolvable bundle path as "still running": no relaunch, reports not-gone', async () => {
    const calls: Array<[string, string[]]> = [];
    const result = await restartBrowser(
      { bundleId: 'x.y.z' },
      {
        run: async (file, args) => { calls.push([file, args]); return { stdout: '' }; },
        appPathFor: async () => '',            // mdfind found nothing
        sleep: async () => {},
        now: (() => { let t = 0; return () => (t += 5_000); })(),
        quitTimeoutMs: 12_000,
        // NOTE: no isRunning override → exercises the real default probe.
      },
    );
    expect(result.ok).toBe(false);
    expect(result.relaunched).toBe(false);
    expect(calls.some(c => c[0] === 'open')).toBe(false); // never relaunched on unknown
  });

  it('treats a ps error as "still running": no relaunch', async () => {
    const calls: Array<[string, string[]]> = [];
    const result = await restartBrowser(
      { bundleId: 'company.thebrowser.Browser' },
      {
        run: async (file, args) => {
          calls.push([file, args]);
          if (file === 'ps') throw new Error('ps boom');
          return { stdout: '' };
        },
        appPath: '/Applications/Arc.app',
        sleep: async () => {},
        now: (() => { let t = 0; return () => (t += 5_000); })(),
        quitTimeoutMs: 12_000,
      },
    );
    expect(result.ok).toBe(false);
    expect(calls.some(c => c[0] === 'open')).toBe(false);
  });

  it('relaunches once ps shows the app gone', async () => {
    let psCall = 0;
    const calls: Array<[string, string[]]> = [];
    const result = await restartBrowser(
      { bundleId: 'company.thebrowser.Browser', openArgs: ['--restore-last-session'] },
      {
        run: async (file, args) => {
          calls.push([file, args]);
          if (file === 'ps') {
            psCall++;
            // first poll: still running; second: gone.
            return { stdout: psCall === 1 ? '/Applications/Arc.app/Contents/MacOS/Arc' : '/usr/bin/other' };
          }
          return { stdout: '' };
        },
        appPath: '/Applications/Arc.app',
        sleep: async () => {},
        now: (() => { let t = 0; return () => (t += 100); })(),
      },
    );
    expect(result).toEqual({ ok: true, quit: true, relaunched: true });
    const open = calls.find(c => c[0] === 'open')!;
    expect(open[1]).toEqual(['-b', 'company.thebrowser.Browser', '--args', '--restore-last-session']);
  });
});
