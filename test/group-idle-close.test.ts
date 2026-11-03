import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DEFAULT_GROUP_IDLE_CLOSE, groupIdleCloseMs, normalizeGroupIdleClose, parseGroupIdleClose } from '../src/core/group-idle-close.js';

const settings = { enabled: true, duration: 2, unit: 'hours' as const };

it('defaults off, converts units and rejects invalid durations without coercion', () => {
  expect(DEFAULT_GROUP_IDLE_CLOSE.enabled).toBe(false);
  expect(groupIdleCloseMs(settings)).toBe(7_200_000);
  expect(groupIdleCloseMs({ ...settings, unit: 'days' })).toBe(172_800_000);
  for (const duration of [0, -1, 1.5, '2', '', null, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    expect(() => parseGroupIdleClose({ ...settings, duration })).toThrow();
  }
  for (const value of [null, [], {}, { ...settings, enabled: 'true' }, { ...settings, unit: 'minutes' }]) {
    expect(() => parseGroupIdleClose(value)).toThrow();
  }
  expect(normalizeGroupIdleClose({ oc_a: settings, oc_bad: { ...settings, duration: 0 }, bad: settings }))
    .toEqual({ oc_a: settings });
});

it('persists per-bot/group policies, preserves other fields and reloads exact values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'group-idle-close-'));
  const path = join(dir, 'bots.json');
  const previous = process.env.BOTS_CONFIG;
  process.env.BOTS_CONFIG = path;
  try {
    writeFileSync(path, JSON.stringify([
      { larkAppId: 'app-a', larkAppSecret: 'test', cliId: 'codex', groupSerialInput: { oc_a: true } },
      { larkAppId: 'app-b', larkAppSecret: 'test', cliId: 'claude-code' },
    ]));
    vi.resetModules();
    const registry = await import('../src/bot-registry.js');
    const { setGroupIdleClose } = await import('../src/services/group-idle-close-store.js');
    registry.loadBotConfigs().forEach(config => registry.registerBot(config));
    expect(registry.getBot('app-a').config.groupIdleClose).toEqual({});
    await Promise.all([
      setGroupIdleClose('app-a', 'oc_a', settings),
      setGroupIdleClose('app-a', 'oc_b', { ...settings, unit: 'days' }),
      setGroupIdleClose('app-b', 'oc_a', { ...settings, duration: 3 }),
    ]);
    await setGroupIdleClose('app-a', 'oc_a', { ...settings, enabled: false });
    const disk = JSON.parse(readFileSync(path, 'utf8'));
    expect(disk[0].groupIdleClose).toEqual({ oc_a: { ...settings, enabled: false }, oc_b: { ...settings, unit: 'days' } });
    expect(disk[1].groupIdleClose).toEqual({ oc_a: { ...settings, duration: 3 } });
    expect(disk[0].groupSerialInput).toEqual({ oc_a: true });
    expect(registry.getBot('app-a').config.groupIdleClose).toEqual(disk[0].groupIdleClose);
    expect(registry.loadBotConfigs()[0].groupIdleClose).toEqual(disk[0].groupIdleClose);
    const before = readFileSync(path, 'utf8');
    await expect(setGroupIdleClose('app-a', 'invalid', settings)).rejects.toThrow('invalid_chat_id');
    await expect(setGroupIdleClose('app-a', 'oc_a', { ...settings, duration: 1.2 })).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);
  } finally {
    if (previous === undefined) delete process.env.BOTS_CONFIG;
    else process.env.BOTS_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
