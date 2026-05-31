/**
 * Bot ownership store: auto-assign (no steal) + explicit override.
 * Run: pnpm vitest run test/bot-owner-store.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
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
