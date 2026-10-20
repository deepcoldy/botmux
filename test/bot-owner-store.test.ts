/**
 * Bot ownership store: auto-assign (no steal) + explicit override.
 * Run: pnpm vitest run test/bot-owner-store.test.ts
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '../src/utils/logger.js';
import { getBotOwner, setBotOwner, clearBotOwner, listBotOwners } from '../src/services/bot-owner-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-owner-')); });

describe('bot-owner-store', () => {
  it('auto-assigns when unowned, does NOT steal an existing owner', () => {
    expect(setBotOwner(dataDir, 'cli_a', { unionId: 'on_1', name: '张三' })).toBe(true);
    expect(getBotOwner(dataDir, 'cli_a')).toMatchObject({ unionId: 'on_1', name: '张三', assignedBy: 'auto' });
    // second auto attempt by someone else must not override
    expect(setBotOwner(dataDir, 'cli_a', { unionId: 'on_2', name: '李四' })).toBe(false);
    expect(getBotOwner(dataDir, 'cli_a')!.unionId).toBe('on_1');
  });

  it('explicit override (归到我名下) reassigns and marks manual', () => {
    setBotOwner(dataDir, 'cli_a', { unionId: 'on_1' });
    expect(setBotOwner(dataDir, 'cli_a', { unionId: 'on_2', name: '李四' }, { override: true })).toBe(true);
    expect(getBotOwner(dataDir, 'cli_a')).toMatchObject({ unionId: 'on_2', assignedBy: 'manual' });
  });

  it('requires an identity (unionId or openId)', () => {
    expect(setBotOwner(dataDir, 'cli_a', { name: '只有名字' })).toBe(false);
    expect(getBotOwner(dataDir, 'cli_a')).toBeNull();
  });

  it('clear removes ownership', () => {
    setBotOwner(dataDir, 'cli_a', { openId: 'ou_1' });
    expect(clearBotOwner(dataDir, 'cli_a')).toBe(true);
    expect(getBotOwner(dataDir, 'cli_a')).toBeNull();
    expect(clearBotOwner(dataDir, 'cli_a')).toBe(false);
  });

  it('lists owners per bot', () => {
    setBotOwner(dataDir, 'cli_a', { unionId: 'on_1' });
    setBotOwner(dataDir, 'cli_b', { unionId: 'on_2' });
    expect(Object.keys(listBotOwners(dataDir)).sort()).toEqual(['cli_a', 'cli_b']);
  });
});

describe('bot-owner-store: corrupt file is quarantined, not overwritten', () => {
  beforeEach(() => { vi.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('keeps the corrupt bytes as bot-owners.json.corrupt-* after the next write', () => {
    const corrupt = '{"cli_old":{"unionId":"on_old","assignedAt":1,"assignedBy":"manual"';
    writeFileSync(join(dataDir, 'bot-owners.json'), corrupt);

    expect(listBotOwners(dataDir)).toEqual({}); // soft read: still degrades to empty
    expect(setBotOwner(dataDir, 'cli_new', { unionId: 'on_1' })).toBe(true); // ... and writes proceed

    const quarantined = readdirSync(dataDir).filter(f => f.startsWith('bot-owners.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(dataDir, quarantined[0]), 'utf-8')).toBe(corrupt);
    expect(Object.keys(JSON.parse(readFileSync(join(dataDir, 'bot-owners.json'), 'utf-8')))).toEqual(['cli_new']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('bot-owner-store'));
  });

  it('a non-object top level (array) is treated as corrupt too', () => {
    writeFileSync(join(dataDir, 'bot-owners.json'), '[]');
    expect(listBotOwners(dataDir)).toEqual({});
    expect(readdirSync(dataDir).filter(f => f.startsWith('bot-owners.json.corrupt-'))).toHaveLength(1);
  });

  it('preserves the on-disk format: 2-space indent + trailing newline', () => {
    setBotOwner(dataDir, 'cli_a', { openId: 'ou_1' }, {}, 42);
    expect(readFileSync(join(dataDir, 'bot-owners.json'), 'utf-8')).toBe(
      JSON.stringify({ cli_a: { openId: 'ou_1', assignedAt: 42, assignedBy: 'auto' } }, null, 2) + '\n',
    );
  });
});
