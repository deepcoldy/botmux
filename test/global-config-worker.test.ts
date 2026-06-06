import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { globalConfigPath, mergeGlobalConfig, readGlobalConfig } from '../src/global-config.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function withHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'botmux-global-config-worker-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  mkdirSync(join(home, '.botmux'), { recursive: true });
  return home;
}

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
});

describe('global worker config', () => {
  it('reads valid worker budget settings from the global config', () => {
    const home = withHome();
    writeFileSync(
      join(home, '.botmux', 'config.json'),
      JSON.stringify({
        worker: {
          maxLiveWorkers: 12,
          idleSuspendMs: 45 * 60_000,
        },
      }),
      { flag: 'w' },
    );

    expect(readGlobalConfig().worker).toEqual({
      maxLiveWorkers: 12,
      idleSuspendMs: 45 * 60_000,
    });
  });

  it('drops invalid worker budget values while preserving unknown keys on write', () => {
    const home = withHome();
    writeFileSync(
      join(home, '.botmux', 'config.json'),
      JSON.stringify({
        unknown: 'keep-me',
        worker: {
          maxLiveWorkers: -1,
          idleSuspendMs: 'nope',
        },
      }),
      { flag: 'w' },
    );

    expect(readGlobalConfig().worker).toBeUndefined();

    mergeGlobalConfig({ worker: { maxLiveWorkers: 10 } as any });
    const raw = JSON.parse(readFileSync(globalConfigPath(), 'utf-8'));
    expect(raw.unknown).toBe('keep-me');
    expect(raw.worker).toEqual({ maxLiveWorkers: 10 });
  });
});
