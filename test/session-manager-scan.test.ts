/**
 * Unit tests for project-scan-root resolution in session-manager.
 *
 * Regression guard for the scan-root semantics: the repo-select card and
 * `/repo` rescan must search for git repos starting FROM the configured
 * workingDir downward — NOT from its parent directory. (Historically the
 * scan rooted at `resolve(workingDir, '..')`, which surfaced unrelated
 * sibling repos; this pins the corrected "scan-from-self" behavior.)
 */
import { describe, it, expect, vi, beforeEach } from 'bun:test';

const mockGetBot = vi.fn();
vi.mock('../src/bot-registry.js', () => ({
  getBot: (id: string) => mockGetBot(id),
  getAllBots: () => [],
  effectiveDefaultWorkingDir: (cfg: any) =>
    cfg?.defaultWorkingDir
    || (cfg?.defaultOncall?.enabled ? cfg.defaultOncall.workingDir : undefined)
    || undefined,
}));

vi.mock('../src/config.js', () => ({
  config: {
    daemon: { workingDir: '~/projects/foo', workingDirs: ['/global/repos'] },
    session: { dataDir: '/tmp/botmux-test' },
  },
}));

import { getProjectScanDir, getProjectScanDirs } from '../src/core/session-manager.js';

const HOME = process.env.HOME ?? '/root';

beforeEach(() => {
  mockGetBot.mockReset();
});

describe('getProjectScanDir (single)', () => {
  it('returns the workingDir itself, not its parent', () => {
    mockGetBot.mockReturnValue({ config: { workingDir: '/repos/foo' } });
    expect(getProjectScanDir({ larkAppId: 'a1' } as any)).toBe('/repos/foo');
  });

  it('expands ~ and still does not climb to the parent', () => {
    mockGetBot.mockReturnValue({ config: { workingDir: '~/projects/foo' } });
    expect(getProjectScanDir({ larkAppId: 'a1' } as any)).toBe(`${HOME}/projects/foo`);
  });
});

describe('getProjectScanDirs (multi)', () => {
  it('uses defaultWorkingDir instead of implicitly scanning HOME', () => {
    mockGetBot.mockReturnValue({ config: { defaultWorkingDir: '~/Code' } });
    expect(getProjectScanDirs({ larkAppId: 'a1' } as any)).toEqual([`${HOME}/Code`]);
  });

  it('keeps workingDirs → workingDir → effective default priority', () => {
    mockGetBot.mockReturnValue({
      config: {
        workingDirs: ['/repos/one', '/repos/two'],
        workingDir: '/legacy/root',
        defaultWorkingDir: '/default/root',
      },
    });
    expect(getProjectScanDirs({ larkAppId: 'a1' } as any)).toEqual(['/repos/one', '/repos/two']);

    mockGetBot.mockReturnValue({
      config: {
        workingDir: '/legacy/root',
        defaultWorkingDir: '/default/root',
      },
    });
    expect(getProjectScanDirs({ larkAppId: 'a1' } as any)).toEqual(['/legacy/root']);
  });

  it('uses the enabled defaultOncall dir as the effective default', () => {
    mockGetBot.mockReturnValue({
      config: {
        defaultOncall: { enabled: true, workingDir: '/oncall/root' },
      },
    });
    expect(getProjectScanDirs({ larkAppId: 'a1' } as any)).toEqual(['/oncall/root']);
  });

  it('scans each configured workingDir from itself, not the parent', () => {
    mockGetBot.mockReturnValue({ config: { workingDir: '/repos/foo' } });
    expect(getProjectScanDirs({ larkAppId: 'a1' } as any)).toEqual(['/repos/foo']);
  });

  it('supports comma-separated workingDir, each rooted at itself', () => {
    mockGetBot.mockReturnValue({ config: { workingDir: '/repos/foo, /repos/bar' } });
    expect(getProjectScanDirs({ larkAppId: 'a1' } as any)).toEqual(['/repos/foo', '/repos/bar']);
  });

  it('supports the workingDirs array, each rooted at itself', () => {
    mockGetBot.mockReturnValue({ config: { workingDirs: ['/repos/foo', '/repos/bar'] } });
    expect(getProjectScanDirs({ larkAppId: 'a1' } as any)).toEqual(['/repos/foo', '/repos/bar']);
  });

  it('includes the session-level workingDir (after /cd) rooted at itself', () => {
    mockGetBot.mockReturnValue({ config: { workingDir: '/repos/foo' } });
    const dirs = getProjectScanDirs({ larkAppId: 'a1', workingDir: '/repos/baz' } as any);
    expect(dirs).toContain('/repos/baz');
    expect(dirs).not.toContain('/repos'); // never the parent
  });

  it('deduplicates the session workingDir after home expansion', () => {
    mockGetBot.mockReturnValue({ config: { defaultWorkingDir: '~/Code' } });
    expect(getProjectScanDirs({
      larkAppId: 'a1',
      workingDir: `${HOME}/Code`,
    } as any)).toEqual([`${HOME}/Code`]);
  });

  it('falls back to global config workingDirs rooted at themselves (no bot)', () => {
    expect(getProjectScanDirs(undefined)).toEqual(['/global/repos']);
  });
});
