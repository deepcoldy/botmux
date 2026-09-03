import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { config } from '../src/config.js';
import * as sessionStore from '../src/services/session-store.js';

describe.sequential('unit-test session persistence', () => {
  const unitRoot = inject('unitSessionDataRoot');
  let isolatedDataDir: string;

  it('isolates both DATA_DIR and BOTMUX_HOME from the invoking environment', () => {
    isolatedDataDir = config.session.dataDir;
    const relativeDataDir = relative(unitRoot, isolatedDataDir);
    const relativeBotmuxHome = relative(unitRoot, dirname(isolatedDataDir));

    expect(relativeDataDir).not.toBe('');
    expect(relativeDataDir.startsWith('..') || isAbsolute(relativeDataDir)).toBe(false);
    expect(relativeBotmuxHome).not.toBe('');
    expect(relativeBotmuxHome.startsWith('..') || isAbsolute(relativeBotmuxHome)).toBe(false);

    sessionStore.init('unit_isolation_probe');
    sessionStore.createSession('oc_probe', 'om_probe', 'unit isolation probe');

    expect(existsSync(join(isolatedDataDir, 'session-stores', 'unit_isolation_probe', 'sessions.db'))).toBe(true);

    process.env.SESSION_DATA_DIR = join(unitRoot, 'leaked-test-override');
  });

  it('repairs a SESSION_DATA_DIR override leaked by the previous test', () => {
    expect(process.env.SESSION_DATA_DIR).toBe(isolatedDataDir);
  });

  describe('with an explicit test override', () => {
    const explicitDataDir = join(unitRoot, 'explicit-test-override');

    beforeEach(() => {
      process.env.SESSION_DATA_DIR = explicitDataDir;
    });

    it('preserves the override selected by the test hook', () => {
      expect(config.session.dataDir).toBe(explicitDataDir);
    });
  });

  it('returns to the managed data directory after an explicit override', () => {
    expect(process.env.SESSION_DATA_DIR).toBe(isolatedDataDir);
  });
});
