import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendSessionMessage,
  listSessionMessages,
  countSessionMessages,
  hasSessionMessages,
  deleteSessionMessages,
} from '../src/services/session-message-store.js';

let dataDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-msg-store-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
});

describe('session-message-store', () => {
  it('appends and lists messages newest-first with monotonic seq', () => {
    const a = appendSessionMessage('sess-1', { role: 'user', content: 'hello', turnId: 't1' });
    const b = appendSessionMessage('sess-1', { role: 'bot', content: 'hi there', turnId: 't2' });
    const c = appendSessionMessage('sess-1', { role: 'user', content: 'again', turnId: 't3' });

    expect(a).toMatchObject({ seq: 0, role: 'user', content: 'hello', turnId: 't1' });
    expect(b).toMatchObject({ seq: 1, role: 'bot', content: 'hi there', turnId: 't2' });
    expect(c).toMatchObject({ seq: 2, role: 'user', content: 'again', turnId: 't3' });

    const all = listSessionMessages('sess-1');
    expect(all.map(m => m.seq)).toEqual([2, 1, 0]);
    expect(countSessionMessages('sess-1')).toBe(3);
    expect(hasSessionMessages('sess-1')).toBe(true);
  });

  it('supports beforeSeq paging into older history', () => {
    for (let i = 0; i < 5; i++) {
      appendSessionMessage('sess-2', { role: 'user', content: `m${i}`, turnId: `t${i}` });
    }
    const page = listSessionMessages('sess-2', { limit: 2, beforeSeq: 4 });
    expect(page.map(m => m.seq)).toEqual([3, 2]);
    const page2 = listSessionMessages('sess-2', { limit: 2, beforeSeq: 2 });
    expect(page2.map(m => m.seq)).toEqual([1, 0]);
  });

  it('dedupes by dedupeKey (turnId) so a worker replay cannot double-append', () => {
    const first = appendSessionMessage('sess-3', { role: 'bot', content: 'reply', turnId: 'turn-x' }, 'turn-x');
    expect(first).not.toBeNull();
    const replay = appendSessionMessage('sess-3', { role: 'bot', content: 'reply', turnId: 'turn-x' }, 'turn-x');
    expect(replay).toBeNull();
    expect(countSessionMessages('sess-3')).toBe(1);
  });

  it('refuses unsafe sessionIds and empty content', () => {
    expect(appendSessionMessage('../../etc/passwd', { role: 'user', content: 'x' })).toBeNull();
    expect(appendSessionMessage('sess-4', { role: 'user', content: '   ' })).toBeNull();
    expect(hasSessionMessages('sess-4')).toBe(false);
  });

  it('persists across reads (same file, append-only JSONL)', () => {
    appendSessionMessage('sess-5', { role: 'user', content: 'persist me', senderName: 'ou_1' });
    appendSessionMessage('sess-5', { role: 'bot', content: 'sure' });
    const raw = readFileSync(join(dataDir, 'messages', 'sess-5.jsonl'), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);
    expect(raw).toContain('"role":"user"');
    // A fresh list (new read pass) returns the same rows.
    const listed = listSessionMessages('sess-5');
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ role: 'bot', content: 'sure' });
  });

  it('deleteSessionMessages clears the archive', () => {
    appendSessionMessage('sess-6', { role: 'user', content: 'x' });
    expect(hasSessionMessages('sess-6')).toBe(true);
    deleteSessionMessages('sess-6');
    expect(hasSessionMessages('sess-6')).toBe(false);
    expect(existsSync(join(dataDir, 'messages', 'sess-6.jsonl'))).toBe(true); // empty file kept
  });

  it('caps content length (runaway CLI replies cannot balloon the archive)', () => {
    const huge = 'x'.repeat(300 * 1024);
    const stored = appendSessionMessage('sess-7', { role: 'bot', content: huge });
    expect(stored).not.toBeNull();
    expect(stored!.content.length).toBeLessThanOrEqual(256 * 1024);
  });

  it('tolerates a malformed trailing row (concurrent write / crash)', () => {
    appendSessionMessage('sess-8', { role: 'user', content: 'good' });
    // Simulate a torn write: append garbage.
    appendFileSync(join(dataDir, 'messages', 'sess-8.jsonl'), '{broken\n');
    const listed = listSessionMessages('sess-8');
    expect(listed.length).toBe(1);
    expect(listed[0]?.content).toBe('good');
  });
});
