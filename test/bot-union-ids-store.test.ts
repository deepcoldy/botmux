/**
 * bot-union-ids-store: a local bot's OWN union_id learned from its message echo
 * (the platform roster's source of truth).
 * Run: pnpm vitest run test/bot-union-ids-store.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

import { getBotUnionId, recordBotUnionId } from '../src/services/bot-union-ids-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-unionid-')); });

describe('bot-union-ids-store', () => {
  it('records and reads back a bot union_id', () => {
    expect(getBotUnionId(dataDir, 'cli_a')).toBeUndefined();
    expect(recordBotUnionId(dataDir, 'cli_a', 'on_a')).toBe(true);
    expect(getBotUnionId(dataDir, 'cli_a')).toBe('on_a');
  });

  it('is idempotent — same value reports no change', () => {
    recordBotUnionId(dataDir, 'cli_a', 'on_a');
    expect(recordBotUnionId(dataDir, 'cli_a', 'on_a')).toBe(false);
    // a corrected value still writes
    expect(recordBotUnionId(dataDir, 'cli_a', 'on_b')).toBe(true);
    expect(getBotUnionId(dataDir, 'cli_a')).toBe('on_b');
  });

  it('rejects empty ids without polluting the store', () => {
    expect(recordBotUnionId(dataDir, '', 'on_a')).toBe(false);
    expect(recordBotUnionId(dataDir, 'cli_a', '')).toBe(false);
    expect(recordBotUnionId(dataDir, 'cli_a', '   ')).toBe(false);
    expect(getBotUnionId(dataDir, 'cli_a')).toBeUndefined();
  });

  it('keeps per-bot entries independent', () => {
    recordBotUnionId(dataDir, 'cli_a', 'on_a');
    recordBotUnionId(dataDir, 'cli_b', 'on_b');
    expect(getBotUnionId(dataDir, 'cli_a')).toBe('on_a');
    expect(getBotUnionId(dataDir, 'cli_b')).toBe('on_b');
  });
});
