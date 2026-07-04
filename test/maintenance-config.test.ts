import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  globalConfigPath,
  readGlobalConfig,
  mergeMaintenanceConfig,
  isValidHhMm,
  parseMaintenancePatch,
} from '../src/global-config.js';

describe('isValidHhMm', () => {
  it('accepts valid 24h times with or without leading zero', () => {
    expect(isValidHhMm('00:00')).toBe(true);
    expect(isValidHhMm('4:00')).toBe(true);
    expect(isValidHhMm('04:30')).toBe(true);
    expect(isValidHhMm('23:59')).toBe(true);
  });
  it('rejects out-of-range or malformed times', () => {
    expect(isValidHhMm('24:00')).toBe(false);
    expect(isValidHhMm('12:60')).toBe(false);
    expect(isValidHhMm('foo')).toBe(false);
    expect(isValidHhMm('')).toBe(false);
    expect(isValidHhMm('4')).toBe(false);
    expect(isValidHhMm('04:5')).toBe(false);
  });
});

describe('maintenance global config', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-maint-config-'));
    vi.stubEnv('HOME', home);
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('absent maintenance section reads as undefined (feature off by default)', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ lang: 'zh' }));
    expect(readGlobalConfig().maintenance).toBeUndefined();
  });

  it('autoUpdate keeps {enabled,time}; autoRestart is a toggle (time ignored)', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      maintenance: {
        autoUpdate: { enabled: true, time: '04:00' },
        autoRestart: { enabled: true, time: '4:30' }, // time on autoRestart is meaningless now
      },
    }));
    expect(readGlobalConfig().maintenance).toEqual({
      autoUpdate: { enabled: true, time: '04:00' },
      autoRestart: { enabled: true },
    });
  });

  it('drops invalid autoUpdate time / non-boolean enabled, keeps the rest', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      maintenance: {
        autoUpdate: { enabled: 'yes', time: '99:99' }, // both invalid → dropped
        autoRestart: { enabled: false },
      },
    }));
    expect(readGlobalConfig().maintenance).toEqual({
      autoRestart: { enabled: false },
    });
  });

  it('mergeMaintenanceConfig round-trips autoUpdate time and preserves unknown sibling keys', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      lang: 'zh',
      dashboard: { publicReadOnly: true },
    }));
    const merged = mergeMaintenanceConfig({ autoUpdate: { enabled: true, time: '03:00' } });
    expect(merged.autoUpdate).toEqual({ enabled: true, time: '03:00' });
    const raw = JSON.parse(readFileSync(globalConfigPath(), 'utf8'));
    expect(raw.lang).toBe('zh');
    expect(raw.dashboard.publicReadOnly).toBe(true);
    expect(raw.maintenance.autoUpdate).toEqual({ enabled: true, time: '03:00' });
  });

  it('mergeMaintenanceConfig merges into existing maintenance without dropping the other key', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      maintenance: { autoUpdate: { enabled: true, time: '05:00' } },
    }));
    mergeMaintenanceConfig({ autoRestart: { enabled: true } });
    const m = readGlobalConfig().maintenance;
    expect(m?.autoUpdate).toEqual({ enabled: true, time: '05:00' });
    expect(m?.autoRestart).toEqual({ enabled: true });
  });

  it('read-after-merge sees fresh value immediately (cache invalidation)', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ maintenance: { autoRestart: { enabled: false } } }));
    expect(readGlobalConfig().maintenance?.autoRestart?.enabled).toBe(false); // prime cache
    mergeMaintenanceConfig({ autoRestart: { enabled: true } });
    expect(readGlobalConfig().maintenance?.autoRestart?.enabled).toBe(true);
  });
});

describe('parseMaintenancePatch (dashboard PUT validation)', () => {
  it('accepts an autoUpdate block with enabled + time', () => {
    expect(parseMaintenancePatch({ autoUpdate: { enabled: true, time: '04:00' } }))
      .toEqual({ ok: true, patch: { autoUpdate: { enabled: true, time: '04:00' } } });
  });
  it('accepts an autoRestart toggle (enabled only; time ignored)', () => {
    expect(parseMaintenancePatch({ autoRestart: { enabled: true, time: '04:00' } }))
      .toEqual({ ok: true, patch: { autoRestart: { enabled: true } } });
  });
  it('accepts both at once', () => {
    expect(parseMaintenancePatch({
      autoUpdate: { enabled: true, time: '04:00' },
      autoRestart: { enabled: false },
    })).toEqual({ ok: true, patch: {
      autoUpdate: { enabled: true, time: '04:00' },
      autoRestart: { enabled: false },
    } });
  });
  it('rejects an invalid autoUpdate time', () => {
    expect(parseMaintenancePatch({ autoUpdate: { time: '99:99' } })).toEqual({ ok: false, error: 'invalid_time' });
  });
  it('rejects a non-boolean enabled on either key', () => {
    expect(parseMaintenancePatch({ autoUpdate: { enabled: 'yes' } })).toEqual({ ok: false, error: 'invalid_enabled' });
    expect(parseMaintenancePatch({ autoRestart: { enabled: 1 } })).toEqual({ ok: false, error: 'invalid_enabled' });
  });
  it('rejects a non-object task', () => {
    expect(parseMaintenancePatch({ autoRestart: 'x' })).toEqual({ ok: false, error: 'invalid_task' });
  });
  it('rejects empty / non-object input', () => {
    expect(parseMaintenancePatch({})).toEqual({ ok: false, error: 'empty' });
    expect(parseMaintenancePatch(null)).toEqual({ ok: false, error: 'empty' });
  });
});
