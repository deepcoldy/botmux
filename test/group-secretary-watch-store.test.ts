import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSecretaryWatches, parseWatchInterval, removeSecretaryWatch, upsertSecretaryWatch } from '../src/services/group-secretary-watch-store.js';
import { selectGroupContextConversation } from '../src/services/group-context-scope.js';

describe('secretary watch store', () => {
  it('upserts per (chat, thread), removes, and rejects too-short intervals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-watch-'));
    const t0 = Date.now();
    upsertSecretaryWatch('cli_a', { chatId: 'oc_1', threadRoot: 'om_t', everyMs: 600_000, createdAt: t0, note: 'x' }, dir);
    upsertSecretaryWatch('cli_a', { chatId: 'oc_1', threadRoot: 'om_t', everyMs: 1_200_000, createdAt: t0, expiresAt: t0 + 3_600_000 }, dir);
    expect(listSecretaryWatches('cli_a', dir)).toEqual([{ chatId: 'oc_1', threadRoot: 'om_t', everyMs: 1_200_000, createdAt: t0, expiresAt: t0 + 3_600_000 }]);
    upsertSecretaryWatch('cli_a', { chatId: 'oc_1', threadRoot: 'om_old', everyMs: 600_000, createdAt: t0 - 2 * 86_400_000 }, dir);
    expect(listSecretaryWatches('cli_a', dir).map(w => w.threadRoot)).toEqual(['om_t']);
    expect(listSecretaryWatches('cli_b', dir)).toEqual([]);
    expect(() => upsertSecretaryWatch('cli_a', { chatId: 'oc_1', threadRoot: 'om_u', everyMs: 30_000, createdAt: Date.now() }, dir)).toThrow();
    expect(removeSecretaryWatch('cli_a', 'oc_1', 'om_t', dir)).toBe(true);
    expect(removeSecretaryWatch('cli_a', 'oc_1', 'om_t', dir)).toBe(false);
  });
  it('parses intervals', () => {
    expect(parseWatchInterval('10m')).toBe(600_000);
    expect(parseWatchInterval('1h')).toBe(3_600_000);
    expect(parseWatchInterval('15')).toBe(900_000);
    expect(parseWatchInterval(undefined)).toBe(600_000);
    expect(() => parseWatchInterval('soon')).toThrow();
  });
});

describe("group context scope 'all'", () => {
  it('keeps both main and thread messages', () => {
    const msgs = [
      { seq: 1, messageId: 'om_1', chatId: 'oc_1', conversationScope: 'main' as const },
      { seq: 2, messageId: 'om_2', chatId: 'oc_1', rootId: 'om_1', threadId: 'omt_1', conversationScope: 'thread' as const },
    ];
    expect(selectGroupContextConversation(msgs, { scope: 'all' }).map(m => m.messageId)).toEqual(['om_1', 'om_2']);
    expect(selectGroupContextConversation(msgs, { scope: 'main' }).map(m => m.messageId)).toEqual(['om_1']);
  });
});
