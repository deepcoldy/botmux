import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseBotConfigsFromText } from '../src/bot-registry.js';
import {
  globalConfigPath,
  invalidateGlobalConfigCache,
  readGlobalConfig,
} from '../src/global-config.js';

describe('LinkRef persisted configuration', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-link-ref-config-'));
    vi.stubEnv('HOME', home);
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
  });

  afterEach(() => {
    invalidateGlobalConfigCache();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    [{ mode: 'disabled' }, 'disabled'],
    [{ mode: 'observe' }, 'observe'],
    [{ mode: 'enabled' }, 'enabled'],
    [{ mode: 'strict' }, undefined],
    [undefined, undefined],
  ] as const)('normalizes global linkRefs %j to %s', (linkRefs, expected) => {
    writeFileSync(globalConfigPath(), JSON.stringify({ linkRefs }));
    invalidateGlobalConfigCache();

    expect(readGlobalConfig().linkRefs?.mode).toBe(expected);
  });

  it('normalizes per-Bot modes without enabling missing or invalid values', () => {
    const base = (id: string, extra: Record<string, unknown> = {}) => ({
      larkAppId: `cli_${id}`,
      larkAppSecret: 'secret',
      ...extra,
    });

    expect(parseBotConfigsFromText(JSON.stringify([
      base('off', { linkRefs: { mode: 'disabled' } }),
      base('observe', { linkRefs: { mode: 'observe' } }),
      base('on', { linkRefs: { mode: 'enabled' } }),
      base('bad', { linkRefs: { mode: 'strict' } }),
      base('missing'),
    ])).map((config) => config.linkRefs?.mode)).toEqual([
      'disabled',
      'observe',
      'enabled',
      undefined,
      undefined,
    ]);
  });
});
