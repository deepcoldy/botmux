import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabaseSync } from '../src/services/sqlite-compat.js';
import { startCursorCot, stopAllCursorCot, type CursorCotEntry } from '../src/services/cursor-cot.js';

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

let dirs: string[] = [];

function setupStore(): { chatsRoot: string; dbPath: string; chatId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-cot-'));
  dirs.push(dir);
  const chatId = 'b80c1234-0000-4000-8000-000000000000';
  const chatsRoot = join(dir, '.cursor', 'chats');
  const chatDir = join(chatsRoot, 'projhash', chatId);
  mkdirSync(chatDir, { recursive: true });
  return { chatsRoot, dbPath: join(chatDir, 'store.db'), chatId };
}

/** Match Cursor's real schema: the SQL primary key is the only unique row
 *  identifier — assistant rows' JSON body id is almost always the literal
 *  "1" (B1). */
async function openRealStore(dbPath: string, withTable = true) {
  const db = await openDatabaseSync(dbPath);
  if (withTable) db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data TEXT)');
  return db;
}

function startCollector(chatsRoot: string, chatId: string): { got: CursorCotEntry[]; waitFor: (count: number) => Promise<void> } {
  const got: CursorCotEntry[] = [];
  let resolver: (() => void) | undefined;
  let wanted = 0;
  startCursorCot(chatId, (entries) => {
    got.push(...entries);
    if (wanted > 0 && got.length >= wanted) {
      wanted = 0;
      resolver?.();
    }
  }, { chatsRoot });
  return {
    got,
    waitFor: (count) => new Promise<void>((resolve) => {
      wanted = count;
      resolver = resolve;
      if (got.length >= count) resolve();
    }),
  };
}

/** Insert one assistant blob whose JSON id is the literal "1" — the real
 *  Cursor shape; the SQL pk must stay unique across turns (B1). */
function insertAssistantTurn(db: { prepare: (sql: string) => { run: (...p: unknown[]) => unknown } }, pk: string, text: string) {
  db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(pk, line({
    id: '1', role: 'assistant',
    content: [{ type: 'reasoning', text }],
  }));
}

afterEach(() => {
  stopAllCursorCot();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('cursor CoT mapping', () => {
  it('maps reasoning / tool-call / tool-result / text blocks in order', async () => {
    const { chatsRoot, dbPath, chatId } = setupStore();
    const init = await openRealStore(dbPath);
    init.close();

    const collector = startCollector(chatsRoot, chatId);
    const callId = 'call-abc\nfc_1';
    const db = await openDatabaseSync(dbPath);
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run('pk-asst-1', line({
      id: '1', role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking first' },
        { type: 'text', text: 'a narration' },
        { type: 'tool-call', toolCallId: callId, toolName: 'Shell', args: { command: 'ls -la /tmp' } },
      ],
    }));
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run('pk-tool-1', line({
      id: 'tool-1', role: 'tool',
      content: [{ type: 'tool-result', toolCallId: callId, result: 'total 0' }],
    }));
    db.close();

    await collector.waitFor(4);
    expect(collector.got.map(e => e.kind)).toEqual(['thinking', 'text', 'tool_call', 'tool_result']);
    expect(collector.got[0]).toMatchObject({ kind: 'thinking', text: 'thinking first' });
    const toolCall = collector.got[2];
    if (toolCall.kind === 'tool_call') {
      expect(toolCall.id).toBe('call-abc_fc_1');
      expect(toolCall.name).toBe('Shell');
      expect(toolCall.subject).toBe('ls -la /tmp');
    }
    expect(collector.got[3]).toMatchObject({ kind: 'tool_result', result: 'total 0' });
  });

  it('B1: renders every assistant turn even though each JSON body id is "1"', async () => {
    const { chatsRoot, dbPath, chatId } = setupStore();
    const init = await openRealStore(dbPath);
    init.close();

    const collector = startCollector(chatsRoot, chatId);
    const db = await openDatabaseSync(dbPath);
    for (let i = 1; i <= 3; i++) insertAssistantTurn(db, `pk-asst-${i}`, `thinking ${i}`);
    db.close();

    await collector.waitFor(3);
    expect(collector.got).toHaveLength(3);
    expect(collector.got.map(e => e.kind)).toEqual(['thinking', 'thinking', 'thinking']);
    expect((collector.got[2] as { text: string }).text).toBe('thinking 3');
  });

  it('F1: user and system rows never produce entries', async () => {
    const { chatsRoot, dbPath, chatId } = setupStore();
    const init = await openRealStore(dbPath);
    init.close();

    const collector = startCollector(chatsRoot, chatId);
    const db = await openDatabaseSync(dbPath);
    const insert = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
    insert.run('pk-user-1', line({
      id: 'user-1', role: 'user',
      content: [{ type: 'text', text: '<user_query>do the thing</user_query>\n<botmux_routing>hidden envelope' }],
    }));
    insert.run('pk-sys-1', line({ id: 'sys-1', role: 'system', content: [{ type: 'text', text: 'system text' }] }));
    insert.run('pk-asst-1', line({
      id: '1', role: 'assistant', content: [{ type: 'reasoning', text: 'real thinking' }],
    }));
    db.close();

    await collector.waitFor(1);
    expect(collector.got).toHaveLength(1);
    expect(collector.got[0]).toMatchObject({ kind: 'thinking', text: 'real thinking' });
  });

  it('skips empty reasoning and unparsable blobs', async () => {
    const { chatsRoot, dbPath, chatId } = setupStore();
    const init = await openRealStore(dbPath);
    init.close();

    const collector = startCollector(chatsRoot, chatId);
    const db = await openDatabaseSync(dbPath);
    const insert = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
    insert.run('pk-asst-1', line({ id: '1', role: 'assistant', content: [{ type: 'reasoning', text: '' }] }));
    insert.run('pk-bad-1', 'not json\n');
    insert.run('pk-asst-2', line({ id: '1', role: 'assistant', content: [{ type: 'reasoning', text: 'later thinking' }] }));
    db.close();

    await collector.waitFor(1);
    expect(collector.got).toEqual([{ kind: 'thinking', text: 'later thinking' }]);
  });

  it('B3: idle ticks with history do not re-sweep old rows', async () => {
    const { chatsRoot, dbPath, chatId } = setupStore();
    // Pre-populate BEFORE starting the reader: head sits exactly at the
    // cursor. A full re-sweep would deliver these (their pks were never
    // seen); idle must read nothing.
    let db = await openRealStore(dbPath);
    for (let i = 1; i <= 5; i++) insertAssistantTurn(db, `pk-old-${i}`, `old ${i}`);
    db.close();

    const collector = startCollector(chatsRoot, chatId);
    await new Promise(r => setTimeout(r, 2800));
    expect(collector.got).toEqual([]);

    // A genuinely new turn (rowid above the cursor) still reads normally.
    db = await openDatabaseSync(dbPath);
    insertAssistantTurn(db, 'pk-new-1', 'new turn');
    db.close();
    await collector.waitFor(1);
    expect(collector.got).toEqual([{ kind: 'thinking', text: 'new turn' }]);
  });

  it('reads a new row reusing the deleted max rowid (equality re-sweep)', async () => {
    const { chatsRoot, dbPath, chatId } = setupStore();
    const init = await openRealStore(dbPath);
    init.close();

    const collector = startCollector(chatsRoot, chatId);
    let db = await openDatabaseSync(dbPath);
    insertAssistantTurn(db, 'pk-asst-1', 'first');
    db.close();
    await collector.waitFor(1);

    // Delete the last row, then insert a NEW turn with a different SQL pk:
    // max(rowid) stays exactly at the cursor, so the tick must re-sweep on
    // equality (not only when max drops below it).
    db = await openDatabaseSync(dbPath);
    db.exec('DELETE FROM blobs');
    insertAssistantTurn(db, 'pk-asst-2', 'second');
    db.close();

    await new Promise(r => setTimeout(r, 1800));
    expect(collector.got).toHaveLength(2);
    expect((collector.got[1] as { text: string }).text).toBe('second');
  });

  it('B4: deleting the head row after history never re-delivers history', async () => {
    const { chatsRoot, dbPath, chatId } = setupStore();
    // History exists BEFORE the reader starts, so its pks go into the
    // startup history set. Reader baselines at the last row.
    let db = await openRealStore(dbPath);
    for (let i = 1; i <= 4; i++) insertAssistantTurn(db, `pk-old-${i}`, `old ${i}`);
    db.close();

    const collector = startCollector(chatsRoot, chatId);
    await new Promise(r => setTimeout(r, 1500));
    expect(collector.got).toEqual([]);

    // Simulate cancelling a turn: delete the current head only. Max drops
    // strictly below the cursor with a new head pk — re-sweep triggers, but
    // none of the pre-baseline rows may be delivered.
    db = await openDatabaseSync(dbPath);
    db.exec('DELETE FROM blobs WHERE id = (SELECT id FROM blobs ORDER BY rowid DESC LIMIT 1)');
    db.close();
    await new Promise(r => setTimeout(r, 1800));
    expect(collector.got).toEqual([]);

    // A genuinely new turn after the cancel renders only the new content.
    db = await openDatabaseSync(dbPath);
    insertAssistantTurn(db, 'pk-new-1', 'real new turn');
    db.close();
    await collector.waitFor(1);
    expect(collector.got).toEqual([{ kind: 'thinking', text: 'real new turn' }]);
  });

  it('does not replay the same row after a rowid re-sweep', async () => {
    const { chatsRoot, dbPath, chatId } = setupStore();
    const init = await openRealStore(dbPath);
    init.close();

    const collector = startCollector(chatsRoot, chatId);
    let db = await openDatabaseSync(dbPath);
    insertAssistantTurn(db, 'pk-asst-1', 'once only');
    db.close();

    await collector.waitFor(1);
    expect(collector.got).toHaveLength(1);

    // Same SQL primary key reinserted after delete: re-sweep must dedupe it.
    db = await openDatabaseSync(dbPath);
    db.exec('DELETE FROM blobs');
    insertAssistantTurn(db, 'pk-asst-1', 'once only');
    db.close();

    await new Promise(r => setTimeout(r, 1800));
    expect(collector.got).toHaveLength(1);
  });

  it('B2: store with no blobs table starts and never throws', async () => {
    const { chatsRoot, dbPath, chatId } = setupStore();
    // Store file exists, table deliberately missing (Cursor startup ordering).
    const init = await openRealStore(dbPath, false);
    init.close();

    const got: CursorCotEntry[] = [];
    let threw: unknown;
    process.once('uncaughtException', (e) => { threw = e; });
    const ok = startCursorCot(chatId, (entries) => got.push(...entries), { chatsRoot, dbPath });
    expect(ok).toBe(true);
    await new Promise(r => setTimeout(r, 1800));
    expect(got).toEqual([]);
    expect(threw).toBeUndefined();

    // Once the table appears, subsequent blobs render.
    const db = await openDatabaseSync(dbPath);
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data TEXT)');
    insertAssistantTurn(db, 'pk-asst-1', 'after table ready');
    db.close();
    await new Promise(r => setTimeout(r, 1500));
    expect(got).toEqual([{ kind: 'thinking', text: 'after table ready' }]);
  });

  it('returns false when the store cannot be resolved', () => {
    const ok = startCursorCot('missing-chat-id', () => {}, { chatsRoot: join(tmpdir(), 'no-such-root') });
    expect(ok).toBe(false);
  });
});
