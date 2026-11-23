import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutputDeliveryJournal, type OutputSink, type OutputReceipt } from '../src/services/output-delivery-journal.js';
import { outputSnapshot } from '../src/services/universal-output-handoff.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { readOutputJournalPage } from '../src/services/topic-search/output-journal.js';

const app = 'cli_topic_test';
const sink: OutputSink = { kind: 'im', context: { target: { mode: 'thread', rootMessageId: 'om_root' } },
  chatId: 'oc_chat', chatType: 'group' };
let dataDir: string;
let journal: OutputDeliveryJournal | undefined;
let clock: number;
let sequence: number;
beforeEach(() => {
  dataDir = mkdtempSync(join(homedir(), 'topic-output-'));
  clock = 1_800_000_000_000;
  sequence = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock++);
});
afterEach(() => {
  journal?.close(); journal = undefined;
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});
function writer() { return journal ??= new OutputDeliveryJournal(dataDir, app); }
function accept(destination: OutputSink = sink, text = '完整最终答复') {
  const snapshot = outputSnapshot(app, { type: 'final_output', sessionId: 'session_one',
    turnId: `turn_${sequence++}`, lastUuid: 'last_uuid', content: text });
  return writer().accept(snapshot, destination);
}
function settle(id: string, receipt: OutputReceipt = { status: 'delivered', messageId: 'om_final' }) {
  const owner = 'test_owner';
  expect(writer().claim(id, owner)).toBe(true);
  expect(writer().complete(id, owner, receipt)).toBe(true);
}

describe('output delivery journal read-only source', () => {
  it('refuses a journal whose -wal or -shm sidecar is a symlink and never writes through it', () => {
    const filename = writer().filename;
    journal?.close(); journal = undefined;
    rmSync(`${filename}-wal`, { force: true });
    rmSync(`${filename}-shm`, { force: true });
    const outside = join(dataDir, 'outside');
    writeFileSync(outside, 'sidecar target must remain untouched');
    const before = { data: readFileSync(outside), mtime: statSync(outside).mtimeMs };
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${filename}${suffix}`;
      symlinkSync(outside, sidecar);
      try {
        expect(readOutputJournalPage(filename).status).toBe('unreadable');
        expect(readFileSync(outside)).toEqual(before.data);
        expect(statSync(outside).mtimeMs).toBe(before.mtime);
      } finally { rmSync(sidecar, { force: true }); }
    }
  });

  it('reports missing, empty, corrupt, missing-table and unknown-schema sources without creating files', () => {
    const path = join(dataDir, 'output-delivery-journals', `${app}.db`);
    expect(readOutputJournalPage(path).status).toBe('absent');
    expect(existsSync(join(dataDir, 'output-delivery-journals'))).toBe(false);
    expect(readOutputJournalPage(writer().filename).status).toBe('empty');
    const corrupt = join(dataDir, 'corrupt.db');
    writeFileSync(corrupt, 'not sqlite');
    expect(readOutputJournalPage(corrupt).status).toBe('unreadable');
    const missingTable = join(dataDir, 'missing-table.db');
    const db = openDatabaseSyncOrThrow(missingTable);
    db.close();
    expect(readOutputJournalPage(missingTable).status).toBe('absent');
    const unknown = openDatabaseSyncOrThrow(writer().filename);
    try { unknown.exec('PRAGMA user_version=1'); } finally { unknown.close(); }
    expect(readOutputJournalPage(writer().filename).status).toBe('schema_unknown');
  });

  it('uses the settled table column rather than stale JSON state and returns complete content and frozen target', () => {
    const record = accept(sink, '答复'.repeat(3000));
    settle(record.id);
    const path = writer().filename;
    const before = { data: readFileSync(path), mtime: statSync(path).mtimeMs };
    const page = readOutputJournalPage(path);
    expect(page.status).toBe('ready');
    expect(page.malformedLines).toBe(0);
    expect(page.changes).toEqual([{ kind: 'upsert', value: expect.objectContaining({
      id: record.id, sessionId: 'session_one', text: '答复'.repeat(3000), messageId: 'om_final',
      rootMessageId: 'om_root', chatId: 'oc_chat',
    }) }]);
    expect(readOutputJournalPage(path, page.cursor).changes).toEqual(page.changes);
    expect(readFileSync(path)).toEqual(before.data);
    expect(statSync(path).mtimeMs).toBe(before.mtime);
  });

  it('sees pending become settled via updated_at even though the row id does not change', () => {
    const record = accept();
    const pending = readOutputJournalPage(writer().filename);
    expect(pending.changes).toEqual([{ kind: 'remove', id: record.id }]);
    settle(record.id);
    const complete = readOutputJournalPage(writer().filename, pending.cursor);
    expect(complete.changes).toMatchObject([{ kind: 'upsert', value: { id: record.id } }]);
    expect(complete.cursor?.updatedAt).toBeGreaterThan(pending.cursor!.updatedAt);
  });

  it('rereads pending to settled in the same millisecond using the overlap window', () => {
    const frozen = clock;
    vi.mocked(Date.now).mockReturnValue(frozen);
    const record = accept();
    const pending = readOutputJournalPage(writer().filename);
    expect(pending.changes).toEqual([{ kind: 'remove', id: record.id }]);
    settle(record.id);
    const settled = readOutputJournalPage(writer().filename, pending.cursor);
    expect(settled.changes).toMatchObject([{ kind: 'upsert', value: { id: record.id } }]);
    expect(settled.cursor).toEqual({ updatedAt: frozen });
    expect(readOutputJournalPage(writer().filename, settled.cursor).changes).toEqual(settled.changes);
  });

  it('includes writes at the 60-second clock rollback boundary without moving the cursor backwards', () => {
    const frozen = clock;
    vi.mocked(Date.now).mockReturnValue(frozen);
    const first = accept(); settle(first.id);
    const previous = readOutputJournalPage(writer().filename);
    vi.mocked(Date.now).mockReturnValue(frozen - 60_000);
    const rolledBack = accept(); settle(rolledBack.id);
    const page = readOutputJournalPage(writer().filename, previous.cursor);
    expect(page.changes).toContainEqual({ kind: 'upsert', value: expect.objectContaining({ id: rolledBack.id }) });
    expect(page.cursor).toEqual(previous.cursor);
  });

  it('excludes suppressed receipts and non-IM sinks, empty bodies, pending, blocked and rejected records', () => {
    const delivered = accept(); settle(delivered.id);
    const suppressed = accept(); settle(suppressed.id, { status: 'suppressed' });
    const http = accept({ kind: 'http', mode: 'async' }); settle(http.id);
    const managed = accept({ kind: 'managed' }); settle(managed.id);
    const doc = accept({ kind: 'doc', context: {} }); settle(doc.id);
    const suppressedSink = accept({ kind: 'suppressed', reason: 'hidden' }); settle(suppressedSink.id);
    const empty = accept(sink, ''); settle(empty.id);
    const pending = accept();
    const blocked = accept(); writer().claim(blocked.id, 'owner'); writer().block(blocked.id, 'owner', 'blocked');
    const rejected = accept(); writer().claim(rejected.id, 'owner'); writer().rejectTerminal(rejected.id, 'owner', 'rejected');
    const page = readOutputJournalPage(writer().filename);
    expect(page.changes.filter(change => change.kind === 'upsert').map(change => change.value.id)).toEqual([delivered.id]);
    expect(page.changes.filter(change => change.kind === 'remove').map(change => change.id)).toEqual(expect.arrayContaining([
      suppressed.id, http.id, managed.id, doc.id, suppressedSink.id, empty.id, pending.id, blocked.id, rejected.id,
    ]));
    expect(page.malformedLines).toBe(0);
  });

  it('skips malformed value JSON and keeps processing later records', () => {
    const bad = accept(); settle(bad.id);
    const good = accept(); settle(good.id);
    // Corruption injection after the real writer has produced the on-disk format.
    const db = openDatabaseSyncOrThrow(writer().filename);
    try { db.prepare('UPDATE outputs SET value=? WHERE id=?').run('{broken', bad.id); }
    finally { db.close(); }
    const page = readOutputJournalPage(writer().filename);
    expect(page.malformedLines).toBe(1);
    expect(page.changes).toContainEqual({ kind: 'remove', id: bad.id });
    expect(page.changes).toContainEqual({ kind: 'upsert', value: expect.objectContaining({ id: good.id }) });
    expect(page.cursor).toBeDefined();
  });

  it('removes unknown sink kinds without treating them as malformed data', () => {
    const record = accept(); settle(record.id);
    const db = openDatabaseSyncOrThrow(writer().filename);
    try { db.prepare('UPDATE outputs SET value=? WHERE id=?').run(JSON.stringify({ ...record,
      sink: { kind: 'future_sink',context: {} },receipt: { status: 'delivered' } }),record.id); }
    finally { db.close(); }
    const page = readOutputJournalPage(writer().filename);
    expect(page.malformedLines).toBe(0);
    expect(page.changes).toEqual([{ kind: 'remove',id: record.id }]);
  });

  it('orders equal-timestamp rows by id for cursor paging', () => {
    vi.mocked(Date.now).mockReturnValue(clock);
    const records = [accept(), accept(), accept()];
    for (const record of records) settle(record.id);
    const page = readOutputJournalPage(writer().filename);
    const ids = records.map(record => record.id).sort();
    expect(page.changes.map(change => change.kind === 'upsert' ? change.value.id : change.id)).toEqual(ids);
    const remaining = readOutputJournalPage(writer().filename, page.cursor, { updatedAt: clock, id: ids[0] });
    expect(remaining.changes.map(change => change.kind === 'upsert' ? change.value.id : change.id)).toEqual(ids.slice(1));
  });

  it('reads the committed WAL snapshot while another connection holds an uncommitted write', () => {
    const record = accept(); settle(record.id);
    const db = openDatabaseSyncOrThrow(writer().filename);
    db.exec('BEGIN IMMEDIATE');
    try {
      // The real journal fixture is committed; this change must stay invisible until COMMIT.
      db.prepare("UPDATE outputs SET state='blocked',updated_at=? WHERE id=?").run(clock + 100, record.id);
      expect(readOutputJournalPage(writer().filename).changes).toMatchObject([{ kind: 'upsert', value: { id: record.id } }]);
      db.exec('COMMIT');
      expect(readOutputJournalPage(writer().filename).changes).toEqual([{ kind: 'remove', id: record.id }]);
    } finally { db.close(); }
  });
});
