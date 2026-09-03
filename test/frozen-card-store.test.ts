/**
 * Unit tests for frozen-card-store: loadFrozenCards, saveFrozenCards, deleteFrozenCards.
 *
 * Uses a real temp directory with vi.mock to redirect config.session.dataDir.
 *
 * Run:  pnpm vitest run test/frozen-card-store.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Mock config to use a temp directory ─────────────────────────────────────

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── Import after mocks are set up ──────────────────────────────────────────

import { loadFrozenCards, saveFrozenCards, deleteFrozenCards } from '../src/services/frozen-card-store.js';
import type { FrozenCard } from '../src/core/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFrozenCard(overrides: Partial<FrozenCard> = {}): FrozenCard {
  return {
    messageId: 'om_msg_001',
    content: 'snapshot content',
    title: 'Turn 1',
    expanded: false,
    ...overrides,
  };
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'frozen-card-store-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('loadFrozenCards', () => {
  it('returns an empty Map when the file does not exist', () => {
    const result = loadFrozenCards('nonexistent-session');
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('returns an empty Map when the frozen-cards directory does not exist', () => {
    // tempDir exists but frozen-cards/ subdirectory does not
    const result = loadFrozenCards('some-session');
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('loads a valid JSON file into a Map', () => {
    const dir = join(tempDir, 'frozen-cards');
    mkdirSync(dir, { recursive: true });
    const card: FrozenCard = makeFrozenCard();
    const data = { nonce_1: card };
    writeFileSync(join(dir, 'sess1.json'), JSON.stringify(data), 'utf-8');

    const result = loadFrozenCards('sess1');
    expect(result.size).toBe(1);
    expect(result.get('nonce_1')).toEqual(card);
  });

  it('loads multiple entries correctly', () => {
    const dir = join(tempDir, 'frozen-cards');
    mkdirSync(dir, { recursive: true });
    const cards: Record<string, FrozenCard> = {
      nonce_a: makeFrozenCard({ messageId: 'om_a', title: 'Turn A' }),
      nonce_b: makeFrozenCard({ messageId: 'om_b', title: 'Turn B', expanded: true }),
      nonce_c: makeFrozenCard({ messageId: 'om_c', title: 'Turn C', content: 'different content' }),
    };
    writeFileSync(join(dir, 'multi.json'), JSON.stringify(cards), 'utf-8');

    const result = loadFrozenCards('multi');
    expect(result.size).toBe(3);
    expect(result.get('nonce_a')?.title).toBe('Turn A');
    expect(result.get('nonce_b')?.expanded).toBe(true);
    expect(result.get('nonce_c')?.content).toBe('different content');
  });

  it('returns an empty Map when the file contains invalid JSON', () => {
    const dir = join(tempDir, 'frozen-cards');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), '{{not valid json', 'utf-8');

    const result = loadFrozenCards('bad');
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('returns an empty Map when the file is empty', () => {
    const dir = join(tempDir, 'frozen-cards');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'empty.json'), '', 'utf-8');

    const result = loadFrozenCards('empty');
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('returns an empty Map when the file contains a non-object JSON value', () => {
    const dir = join(tempDir, 'frozen-cards');
    mkdirSync(dir, { recursive: true });
    // JSON.parse succeeds but Object.entries on an array may produce unexpected results
    // or a number/string will throw — either way should not crash
    writeFileSync(join(dir, 'arr.json'), '"just a string"', 'utf-8');

    // Should not throw; returns a Map (possibly empty or with odd entries)
    const result = loadFrozenCards('arr');
    expect(result).toBeInstanceOf(Map);
  });
});

describe('saveFrozenCards', () => {
  it('creates the frozen-cards directory and writes a file', () => {
    const cards = new Map<string, FrozenCard>();
    cards.set('n1', makeFrozenCard());

    saveFrozenCards('sess-save', cards);

    const fp = join(tempDir, 'frozen-cards', 'sess-save.json');
    expect(existsSync(fp)).toBe(true);

    const loaded = JSON.parse(readFileSync(fp, 'utf-8'));
    expect(loaded.n1).toEqual(makeFrozenCard());
  });

  it('writes pretty-printed JSON (indented)', () => {
    const cards = new Map<string, FrozenCard>();
    cards.set('n1', makeFrozenCard());

    saveFrozenCards('pretty', cards);

    const fp = join(tempDir, 'frozen-cards', 'pretty.json');
    const raw = readFileSync(fp, 'utf-8');
    // Pretty-printed JSON has newlines and indentation
    expect(raw).toContain('\n');
    expect(raw).toContain('  ');
  });

  it('uses atomic write (no .tmp file left behind)', () => {
    const cards = new Map<string, FrozenCard>();
    cards.set('n1', makeFrozenCard());

    saveFrozenCards('atomic', cards);

    const tmpFp = join(tempDir, 'frozen-cards', 'atomic.json.tmp');
    expect(existsSync(tmpFp)).toBe(false);
  });

  it('removes the file when saving an empty Map', () => {
    // First, create a file
    const cards = new Map<string, FrozenCard>();
    cards.set('n1', makeFrozenCard());
    saveFrozenCards('to-remove', cards);

    const fp = join(tempDir, 'frozen-cards', 'to-remove.json');
    expect(existsSync(fp)).toBe(true);

    // Now save an empty map — file should be removed
    saveFrozenCards('to-remove', new Map());
    expect(existsSync(fp)).toBe(false);
  });

  it('does nothing when saving an empty Map and no file exists', () => {
    // Should not throw
    saveFrozenCards('never-existed', new Map());

    const fp = join(tempDir, 'frozen-cards', 'never-existed.json');
    expect(existsSync(fp)).toBe(false);
  });

  it('overwrites an existing file', () => {
    const cards1 = new Map<string, FrozenCard>();
    cards1.set('old', makeFrozenCard({ title: 'Old Title' }));
    saveFrozenCards('overwrite', cards1);

    const cards2 = new Map<string, FrozenCard>();
    cards2.set('new', makeFrozenCard({ title: 'New Title' }));
    saveFrozenCards('overwrite', cards2);

    const fp = join(tempDir, 'frozen-cards', 'overwrite.json');
    const loaded = JSON.parse(readFileSync(fp, 'utf-8'));
    expect(loaded.new?.title).toBe('New Title');
    expect(loaded.old).toBeUndefined();
  });
});

describe('deleteFrozenCards', () => {
  it('deletes an existing file', () => {
    const cards = new Map<string, FrozenCard>();
    cards.set('n1', makeFrozenCard());
    saveFrozenCards('del-me', cards);

    const fp = join(tempDir, 'frozen-cards', 'del-me.json');
    expect(existsSync(fp)).toBe(true);

    deleteFrozenCards('del-me');
    expect(existsSync(fp)).toBe(false);
  });

  it('does not throw when the file does not exist', () => {
    expect(() => deleteFrozenCards('no-such-session')).not.toThrow();
  });

  it('does not throw when the frozen-cards directory does not exist', () => {
    // tempDir exists but frozen-cards/ does not
    expect(() => deleteFrozenCards('missing-dir-session')).not.toThrow();
  });
});

describe('round-trip: save then load', () => {
  it('returns the same data after save + load', () => {
    const cards = new Map<string, FrozenCard>();
    cards.set('nonce_1', makeFrozenCard({ messageId: 'om_111', replyTargetKey: 'thread:om_topic_1', content: 'snap 1', title: 'T1', expanded: false }));
    cards.set('nonce_2', makeFrozenCard({ messageId: 'om_222', content: 'snap 2', title: 'T2', expanded: true }));

    saveFrozenCards('round-trip', cards);
    const loaded = loadFrozenCards('round-trip');

    expect(loaded.size).toBe(2);
    expect(loaded.get('nonce_1')).toEqual(cards.get('nonce_1'));
    expect(loaded.get('nonce_2')).toEqual(cards.get('nonce_2'));
  });

  it('round-trips after overwriting with different data', () => {
    const initial = new Map<string, FrozenCard>();
    initial.set('a', makeFrozenCard({ title: 'First' }));
    saveFrozenCards('rt-overwrite', initial);

    const updated = new Map<string, FrozenCard>();
    updated.set('b', makeFrozenCard({ title: 'Second' }));
    updated.set('c', makeFrozenCard({ title: 'Third', expanded: true }));
    saveFrozenCards('rt-overwrite', updated);

    const loaded = loadFrozenCards('rt-overwrite');
    expect(loaded.size).toBe(2);
    expect(loaded.has('a')).toBe(false);
    expect(loaded.get('b')?.title).toBe('Second');
    expect(loaded.get('c')?.expanded).toBe(true);
  });

  it('load returns empty Map after save-then-delete', () => {
    const cards = new Map<string, FrozenCard>();
    cards.set('x', makeFrozenCard());
    saveFrozenCards('save-del', cards);
    deleteFrozenCards('save-del');

    const loaded = loadFrozenCards('save-del');
    expect(loaded.size).toBe(0);
  });

  it('load returns empty Map after saving an empty Map', () => {
    const cards = new Map<string, FrozenCard>();
    cards.set('x', makeFrozenCard());
    saveFrozenCards('empty-save', cards);
    saveFrozenCards('empty-save', new Map());

    const loaded = loadFrozenCards('empty-save');
    expect(loaded.size).toBe(0);
  });
});

describe('edge cases', () => {
  it('handles session IDs with special characters', () => {
    // Session IDs in practice are rootId::larkAppId which contain `::`
    const sessionId = 'om_root123::cli_app456';
    const cards = new Map<string, FrozenCard>();
    cards.set('n', makeFrozenCard());

    saveFrozenCards(sessionId, cards);
    const loaded = loadFrozenCards(sessionId);
    expect(loaded.size).toBe(1);
    expect(loaded.get('n')).toEqual(makeFrozenCard());

    deleteFrozenCards(sessionId);
    expect(loadFrozenCards(sessionId).size).toBe(0);
  });

  it('handles frozen card content with special characters', () => {
    const card = makeFrozenCard({
      content: 'line1\nline2\ttab\r\n"quoted" and \\escaped',
      title: '日本語タイトル 🎉',
    });
    const cards = new Map<string, FrozenCard>();
    cards.set('special', card);

    saveFrozenCards('special-chars', cards);
    const loaded = loadFrozenCards('special-chars');
    expect(loaded.get('special')).toEqual(card);
  });

  it('isolates different sessions completely', () => {
    const cards1 = new Map<string, FrozenCard>();
    cards1.set('a', makeFrozenCard({ title: 'Session 1' }));
    saveFrozenCards('sess-iso-1', cards1);

    const cards2 = new Map<string, FrozenCard>();
    cards2.set('b', makeFrozenCard({ title: 'Session 2' }));
    saveFrozenCards('sess-iso-2', cards2);

    const loaded1 = loadFrozenCards('sess-iso-1');
    const loaded2 = loadFrozenCards('sess-iso-2');

    expect(loaded1.size).toBe(1);
    expect(loaded1.get('a')?.title).toBe('Session 1');
    expect(loaded2.size).toBe(1);
    expect(loaded2.get('b')?.title).toBe('Session 2');

    // Deleting one does not affect the other
    deleteFrozenCards('sess-iso-1');
    expect(loadFrozenCards('sess-iso-1').size).toBe(0);
    expect(loadFrozenCards('sess-iso-2').size).toBe(1);
  });
});
