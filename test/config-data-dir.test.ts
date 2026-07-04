/**
 * config.session.dataDir must be a LAZY getter, not a value frozen at import.
 *
 * Several CLI subcommands set SESSION_DATA_DIR *after* config.js is first
 * imported (e.g. `process.env.SESSION_DATA_DIR ??= resolveDataDir()`) and rely
 * on later reads honoring it. If it were a static value, role/capability
 * resolution (resolveTeamRoleFile / getBotCapability, which read
 * config.session.dataDir) would silently read the packaged default dir.
 *
 * Run: pnpm vitest run test/config-data-dir.test.ts
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

afterEach(() => {
  delete process.env.SESSION_DATA_DIR;
  vi.resetModules();
});

describe('config.session.dataDir laziness', () => {
  it('reflects SESSION_DATA_DIR set AFTER the module was imported', async () => {
    delete process.env.SESSION_DATA_DIR;
    vi.resetModules();
    const { config } = await import('../src/config.js');

    const before = config.session.dataDir; // packaged default
    process.env.SESSION_DATA_DIR = '/tmp/botmux-late-dir';
    const after = config.session.dataDir; // must pick up the value set just now

    expect(after).toBe('/tmp/botmux-late-dir');
    expect(after).not.toBe(before);
  });

  it('falls back to the packaged default when SESSION_DATA_DIR is unset', async () => {
    delete process.env.SESSION_DATA_DIR;
    vi.resetModules();
    const { config } = await import('../src/config.js');
    expect(config.session.dataDir).toContain('/data');
  });
});
