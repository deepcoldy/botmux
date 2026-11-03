/**
 * writeWhiteboard goes through atomicWriteFileSync: content lands intact (trailing newline
 * normalised), no tmp residue is left behind, and CAS / empty-content guards still hold.
 * Run: npx vitest run --project unit test/whiteboard-store-write.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return tempDir; } } },
}));
vi.mock('../src/global-config.js', () => ({
  readGlobalConfig: () => ({ whiteboard: { enabled: true } }),
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { createWhiteboard, whiteboardBoardPath, writeWhiteboard } from '../src/services/whiteboard-store.js';

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'botmux-wb-write-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('writeWhiteboard (atomic board write)', () => {
  it('overwrites the board, appends a trailing newline, leaves no *.tmp behind', () => {
    const meta = createWhiteboard({ scope: 'session' } as any);
    writeWhiteboard(meta.id, 'hello board');
    expect(readFileSync(whiteboardBoardPath(meta.id), 'utf-8')).toBe('hello board\n');
    writeWhiteboard(meta.id, 'second\n');
    expect(readFileSync(whiteboardBoardPath(meta.id), 'utf-8')).toBe('second\n');
    const boardDir = join(tempDir, 'whiteboards', meta.id);
    expect(readdirSync(boardDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('still rejects empty content and stale CAS without touching the board', () => {
    const meta = createWhiteboard({ scope: 'session' } as any);
    writeWhiteboard(meta.id, 'keep');
    expect(() => writeWhiteboard(meta.id, '   ')).toThrow('whiteboard_empty_content');
    expect(() => writeWhiteboard(meta.id, 'x', { expectedUpdatedAt: '1970-01-01T00:00:00.000Z' })).toThrow('whiteboard_cas_mismatch');
    expect(readFileSync(whiteboardBoardPath(meta.id), 'utf-8')).toBe('keep\n');
  });
});
