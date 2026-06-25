import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordObservedBotUnionId,
  getBotUnionIdByName,
  listBotUnionIds,
} from '../src/services/observed-bot-union-ids-store.js';

describe('observed-bot-union-ids-store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bui-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('records and looks up by name case-insensitively', () => {
    expect(recordObservedBotUnionId(dir, 'traex-loopy(d2)', 'on_abc', 'ou_x')).toBe(true);
    expect(getBotUnionIdByName(dir, 'traex-loopy(d2)')).toBe('on_abc');
    expect(getBotUnionIdByName(dir, 'TRAEX-LOOPY(D2)')).toBe('on_abc');
  });

  it('returns undefined for unknown or empty names', () => {
    expect(getBotUnionIdByName(dir, 'nope')).toBeUndefined();
    expect(getBotUnionIdByName(dir, '')).toBeUndefined();
    expect(getBotUnionIdByName(dir, '   ')).toBeUndefined();
  });

  it('does not write empty names or union ids', () => {
    expect(recordObservedBotUnionId(dir, '', 'on_x')).toBe(false);
    expect(recordObservedBotUnionId(dir, 'name', '')).toBe(false);
    expect(existsSync(join(dir, 'observed-bot-union-ids.json'))).toBe(false);
  });

  it('keeps firstSeenAt while refreshing the observed identity', () => {
    recordObservedBotUnionId(dir, 'bot', 'on_old', 'ou_1', 1000);
    expect(recordObservedBotUnionId(dir, 'bot', 'on_new', 'ou_2', 5000)).toBe(true);
    const data = JSON.parse(readFileSync(join(dir, 'observed-bot-union-ids.json'), 'utf-8'));
    expect(data.byName.bot).toMatchObject({
      unionId: 'on_new',
      lastOpenId: 'ou_2',
      firstSeenAt: 1000,
      lastSeenAt: 5000,
    });
  });

  it('skips recent duplicate observations and refreshes stale ones', () => {
    recordObservedBotUnionId(dir, 'bot', 'on_x', 'ou_1', 1000);
    expect(recordObservedBotUnionId(dir, 'bot', 'on_x', 'ou_1', 61_000)).toBe(false);
    expect(recordObservedBotUnionId(dir, 'bot', 'on_x', 'ou_1', 661_000)).toBe(true);
  });

  it('lists all learned names in normalized form', () => {
    recordObservedBotUnionId(dir, 'Alpha', 'on_a');
    recordObservedBotUnionId(dir, 'Beta', 'on_b');
    expect(listBotUnionIds(dir)).toEqual({ alpha: 'on_a', beta: 'on_b' });
  });

  it('recovers from a corrupt file', () => {
    const fp = join(dir, 'observed-bot-union-ids.json');
    writeFileSync(fp, '{ not json');
    expect(getBotUnionIdByName(dir, 'x')).toBeUndefined();
    expect(recordObservedBotUnionId(dir, 'x', 'on_x')).toBe(true);
    expect(getBotUnionIdByName(dir, 'x')).toBe('on_x');
  });
});
