import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getGroupContextSettings,
  setGroupContextSettings,
} from '../src/services/group-context-settings-store.js';
import { logger } from '../src/utils/logger.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-group-context-settings-'));
  roots.push(root);
  return root;
}

describe('group context settings store', () => {
  it('defaults sharing off for every managed bot in an unconfigured group', () => {
    const dir = dataDir();
    const expected = {
      enabled: false,
      maxContextChars: 24_000,
      retentionDays: 30,
      maxMessages: 10_000,
    };

    expect(getGroupContextSettings('app_one', 'oc_group', dir)).toEqual(expected);
    expect(getGroupContextSettings('app_two', 'oc_group', dir)).toEqual(expected);
  });

  it('returns disabled defaults for invalid chat IDs and prototype keys', () => {
    const dir = dataDir();
    const expected = {
      enabled: false,
      maxContextChars: 24_000,
      retentionDays: 30,
      maxMessages: 10_000,
    };

    expect(getGroupContextSettings('app_one', '__proto__', dir)).toEqual(expected);
    expect(getGroupContextSettings('app_one', 'constructor', dir)).toEqual(expected);
  });

  it('persists one group-wide setting across bots and module reloads', async () => {
    const dir = dataDir();

    await expect(setGroupContextSettings('oc_group', { enabled: true }, dir)).resolves.toEqual({
      enabled: true,
      maxContextChars: 24_000,
      retentionDays: 30,
      maxMessages: 10_000,
    });
    expect(getGroupContextSettings('app_one', 'oc_group', dir).enabled).toBe(true);
    expect(getGroupContextSettings('app_two', 'oc_group', dir).enabled).toBe(true);

    const path = join(dir, 'group-context-settings.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      schemaVersion: 1,
      configs: {
        oc_group: {
          enabled: true,
          maxContextChars: 24_000,
          retentionDays: 30,
          maxMessages: 10_000,
        },
      },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    vi.resetModules();
    const fresh = await import('../src/services/group-context-settings-store.js');
    expect(fresh.getGroupContextSettings('app_three', 'oc_group', dir).enabled).toBe(true);
  });

  it('accepts each inclusive numeric boundary', async () => {
    const dir = dataDir();

    await expect(setGroupContextSettings('oc_bounds', {
      enabled: true,
      maxContextChars: 1_000,
      retentionDays: 1,
      maxMessages: 100,
    }, dir)).resolves.toEqual({
      enabled: true,
      maxContextChars: 1_000,
      retentionDays: 1,
      maxMessages: 100,
    });
    await expect(setGroupContextSettings('oc_bounds', {
      maxContextChars: 100_000,
      retentionDays: 365,
      maxMessages: 100_000,
    }, dir)).resolves.toEqual({
      enabled: true,
      maxContextChars: 100_000,
      retentionDays: 365,
      maxMessages: 100_000,
    });
  });

  it.each([
    ['chat id', 'bad_chat', { enabled: true }],
    ['enabled type', 'oc_group', { enabled: 'true' }],
    ['minimum context', 'oc_group', { maxContextChars: 999 }],
    ['maximum context', 'oc_group', { maxContextChars: 100_001 }],
    ['integer context', 'oc_group', { maxContextChars: 1_000.5 }],
    ['minimum retention', 'oc_group', { retentionDays: 0 }],
    ['maximum retention', 'oc_group', { retentionDays: 366 }],
    ['minimum messages', 'oc_group', { maxMessages: 99 }],
    ['maximum messages', 'oc_group', { maxMessages: 100_001 }],
  ])('rejects an invalid %s', async (_label, chatId, patch) => {
    const dir = dataDir();
    await expect(setGroupContextSettings(
      chatId,
      patch as unknown as Parameters<typeof setGroupContextSettings>[1],
      dir,
    )).rejects.toThrow();
  });

  it('serializes concurrent updates without losing fields or other groups', async () => {
    const dir = dataDir();

    await Promise.all([
      setGroupContextSettings('oc_alpha', { enabled: true }, dir),
      setGroupContextSettings('oc_beta', { maxMessages: 444 }, dir),
    ]);
    await Promise.all([
      setGroupContextSettings('oc_alpha', { maxContextChars: 8_000 }, dir),
      setGroupContextSettings('oc_alpha', { retentionDays: 7 }, dir),
    ]);

    expect(getGroupContextSettings('app_a', 'oc_alpha', dir)).toEqual({
      enabled: true,
      maxContextChars: 8_000,
      retentionDays: 7,
      maxMessages: 10_000,
    });
    expect(getGroupContextSettings('app_b', 'oc_beta', dir)).toEqual({
      enabled: false,
      maxContextChars: 24_000,
      retentionDays: 30,
      maxMessages: 444,
    });
  });

  it('fails closed with a warning when stored settings are malformed', () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'group-context-settings.json'), JSON.stringify({
      schemaVersion: 1,
      configs: { oc_group: { enabled: true } },
    }));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(getGroupContextSettings('app_one', 'oc_group', dir)).toEqual({
      enabled: false,
      maxContextChars: 24_000,
      retentionDays: 30,
      maxMessages: 10_000,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('group-context-settings'));
    warn.mockRestore();
  });

  it('refuses to overwrite a malformed registry', async () => {
    const dir = dataDir();
    const path = join(dir, 'group-context-settings.json');
    const malformed = '{"schemaVersion":1,"configs":';
    writeFileSync(path, malformed);

    await expect(setGroupContextSettings('oc_group', { enabled: true }, dir)).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe(malformed);
  });

  it('replaces a leaf symlink without modifying its target', async () => {
    const dir = dataDir();
    const victimDir = dataDir();
    const victim = join(victimDir, 'victim.json');
    const path = join(dir, 'group-context-settings.json');
    const victimContents = JSON.stringify({ schemaVersion: 1, configs: {} });
    writeFileSync(victim, victimContents);
    symlinkSync(victim, path);

    await setGroupContextSettings('oc_group', { enabled: true }, dir);

    expect(readFileSync(victim, 'utf8')).toBe(victimContents);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(getGroupContextSettings('app_one', 'oc_group', dir).enabled).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
