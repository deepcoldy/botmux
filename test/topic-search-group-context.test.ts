import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetGroupContextStoreForTest, groupContextDbPath, markGroupContextMessageDeleted,
  pruneGroupContext, upsertGroupContextMessage, type GroupContextMessageInput } from '../src/services/group-context-store.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { readGroupContextPage } from '../src/services/topic-search/group-context.js';
import { readJsonlPage, enumerateSources, readTopicSessions, sessionQueueAnchor } from '../src/services/topic-search/sources.js';
import { createSession, init } from '../src/services/session-store.js';

const app = 'cli_topic_group';
const chat = 'oc_chat';
const root = 'om_root';
let dataDir: string;
const anchors = new Set([chat, root]);
function message(overrides: Partial<GroupContextMessageInput> = {}): GroupContextMessageInput {
  return { messageId: 'om_message', chatId: chat, rootId: root, threadId: 'omt_thread',
    conversationScope: 'thread', senderId: 'ou_sender', senderType: 'user', msgType: 'text',
    text: '话题正文', createTime: Date.now(), resourceRefs: [], sourceAppId: app, ...overrides };
}
function path() { return groupContextDbPath(app); }
beforeEach(() => {
  dataDir = mkdtempSync(join(homedir(), 'topic-group-'));
  vi.stubEnv('SESSION_DATA_DIR', dataDir);
  _resetGroupContextStoreForTest();
});
afterEach(() => {
  _resetGroupContextStoreForTest();
  init('cli_topic_detached', { owner: false });
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('group-context read-only source', () => {
  it('reports an oversized pending request as a caller error before opening the source', () => {
    expect(() => readGroupContextPage(path(),anchors,{ pendingSeqs: Array.from({ length: 2001 },(_,i) => i) }))
      .toThrow('group_pending_page_too_large');
    expect(existsSync(join(dataDir,'group-context'))).toBe(false);
  });
  it('does not create missing libraries and reports an empty real-writer library', () => {
    expect(readGroupContextPage(path(), anchors).status).toBe('absent');
    expect(existsSync(join(dataDir, 'group-context'))).toBe(false);
    upsertGroupContextMessage(app, message());
    pruneGroupContext(app, chat, { maxAgeMs: 1, now: Date.now() + 1000 });
    expect(readGroupContextPage(path(), anchors)).toMatchObject({ status: 'empty', changes: [], chats: [
      { chatId: chat, prunedCount: 1 },
    ] });
  });

  it.each([1, 2, 3, 4, 5])('reads schema v%i without migration or touching missing columns', version => {
    upsertGroupContextMessage(app, message({ updateTime: Date.now() + 1 }));
    _resetGroupContextStoreForTest();
    const db = openDatabaseSyncOrThrow(path());
    try {
      // Produce rows with the real writer, then remove columns absent in historical versions.
      if (version < 5) db.exec('ALTER TABLE messages DROP COLUMN mentions; ALTER TABLE messages DROP COLUMN raw_text');
      if (version < 4) db.exec('ALTER TABLE messages DROP COLUMN conversation_scope');
      if (version < 3) db.exec('ALTER TABLE messages DROP COLUMN card_content_version');
      if (version < 2) db.exec('ALTER TABLE messages DROP COLUMN update_time');
      db.exec(`PRAGMA user_version=${version}`);
      // Bun's default close() keeps the store's writer open until GC finalizes its statements;
      // fold the WAL into the main file now so a deferred close cannot rewrite it mid-assertion.
      expect(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()).toMatchObject({ busy: 0 });
    } finally { db.close(); }
    const before = { bytes: readFileSync(path()), mtime: statSync(path()).mtimeMs };
    const page = readGroupContextPage(path(), anchors);
    expect(page.status).toBe('ready');
    expect(page.changes).toMatchObject([{ kind: 'upsert', value: { messageId: 'om_message', anchor: root, text: '话题正文' } }]);
    expect(readFileSync(path())).toEqual(before.bytes);
    expect(statSync(path()).mtimeMs).toBe(before.mtime);
    const check = openDatabaseSyncOrThrow(path(), { readOnly: true });
    try { expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: version }); }
    finally { check.close(); }
  });

  it('skips a future schema and unreadable libraries without throwing', () => {
    upsertGroupContextMessage(app, message());
    _resetGroupContextStoreForTest();
    const db = openDatabaseSyncOrThrow(path());
    try { db.exec('PRAGMA user_version=6'); } finally { db.close(); }
    expect(readGroupContextPage(path(), anchors).status).toBe('schema_unknown');
    const corrupt = join(dataDir, 'corrupt.sqlite');
    writeFileSync(corrupt, 'not sqlite');
    expect(readGroupContextPage(corrupt, anchors).status).toBe('unreadable');
  });

  it('keeps only the latest revision while advancing the seq cursor over obsolete rows', () => {
    const first = upsertGroupContextMessage(app, message({ text: 'initial' }));
    const second = upsertGroupContextMessage(app, message({ text: 'edited' }));
    const page = readGroupContextPage(path(), anchors);
    expect(page.changes).toMatchObject([{ kind: 'upsert', value: { seq: second.seq, revision: second.revision, text: 'edited' } }]);
    expect(page.changes).toHaveLength(1);
    expect(page.cursorSeq).toBe(second.seq);
    expect(readGroupContextPage(path(), anchors, { afterSeq: first.seq }).changes).toMatchObject([
      { kind: 'upsert', value: { text: 'edited' } },
    ]);
    expect(readGroupContextPage(path(), anchors, { afterSeq: page.cursorSeq }).changes).toEqual([]);
    expect(readGroupContextPage(path(), anchors, { pendingSeqs: [first.seq] }).changes).toEqual([]);
  });

  it('returns recall evidence even when the queue retains the message and its anchor has no session', () => {
    upsertGroupContextMessage(app, message());
    const deleted = markGroupContextMessageDeleted(app, chat, 'om_message');
    // A retained queue appearance must not prevent the caller applying this tombstone globally.
    mkdirSync(join(dataDir, 'queues'));
    writeFileSync(join(dataDir, 'queues/om_root.jsonl'), JSON.stringify({ messageId: 'om_message', content: 'retained queue text' }) + '\n');
    const queue = readJsonlPage(enumerateSources(dataDir, 'queue').files[0]);
    expect(queue.rows[0].row.value.messageId).toBe('om_message');
    const page = readGroupContextPage(path(), new Set());
    expect(page.changes).toMatchObject([{ kind: 'recall', value: { messageId: 'om_message', seq: deleted.seq } }]);
    expect(page.changes).toHaveLength(1);
  });

  it('rereads an unverified card upgraded in place without a new seq', () => {
    const first = upsertGroupContextMessage(app, message({ msgType: 'interactive', text: 'final card body' }));
    const pending = readGroupContextPage(path(), anchors);
    expect(pending.changes).toMatchObject([{ kind: 'pending', reason: 'unverified_card', value: { seq: first.seq } }]);
    const upgraded = upsertGroupContextMessage(app, message({ msgType: 'interactive', text: 'final card body', cardContentVersion: 1 }));
    expect(upgraded.seq).toBe(first.seq);
    expect(readGroupContextPage(path(), anchors, { afterSeq: pending.cursorSeq }).changes).toEqual([]);
    expect(readGroupContextPage(path(), anchors, { pendingSeqs: [first.seq] }).changes).toMatchObject([
      { kind: 'upsert', value: { seq: first.seq, text: 'final card body' } },
    ]);
  });

  it('backfills a pending message when a local bot session later appears', () => {
    const first = upsertGroupContextMessage(app, message());
    const before = new Set(readTopicSessions(dataDir).sessions.map(sessionQueueAnchor));
    expect(readGroupContextPage(path(), before).changes).toMatchObject([{ kind: 'pending', reason: 'no_session' }]);
    init(app);
    createSession(chat, root, 'new local topic', 'group', 'thread');
    init('cli_topic_detached', { owner: false });
    const after = new Set(readTopicSessions(dataDir).sessions.map(sessionQueueAnchor));
    expect(readGroupContextPage(path(), after, { pendingSeqs: [first.seq] }).changes).toMatchObject([
      { kind: 'upsert', value: { anchor: root } },
    ]);
  });

  it('uses chat anchor for main conversations and v4+ rows without proven thread scope', () => {
    upsertGroupContextMessage(app, message({ messageId: 'om_main', conversationScope: 'main' }));
    upsertGroupContextMessage(app, message({ messageId: 'om_unknown', rootId: undefined, conversationScope: undefined }));
    const page = readGroupContextPage(path(), new Set([chat]));
    expect(page.changes).toHaveLength(2);
    expect(page.changes.every(change => change.kind === 'upsert' && change.value.anchor === chat)).toBe(true);
  });

  it('reports retention counters and enumerates surviving keys for per-chat existence reconciliation', () => {
    const now = Date.now();
    const old = upsertGroupContextMessage(app, message({ messageId: 'om_old', createTime: now - 1000 }));
    upsertGroupContextMessage(app, message({ messageId: 'om_new', createTime: now }));
    const before = readGroupContextPage(path(), anchors);
    pruneGroupContext(app, chat, { maxRows: 1, maxAgeMs: 100_000, now });
    const changed = readGroupContextPage(path(), anchors, { afterSeq: before.cursorSeq });
    expect(changed.chats).toEqual([{ chatId: chat, prunedCount: 1, prunedThroughSeq: old.seq }]);
    expect(changed.changes).toEqual([]);
    const surviving = readGroupContextPage(path(), anchors, { chatId: chat });
    expect(surviving.changes.map(change => change.value.messageId)).toEqual(['om_new']);
    expect(readGroupContextPage(path(), anchors, { pendingSeqs: [old.seq] }).changes).toEqual([]);
  });

  it('releases its read snapshot on close so a live writer can checkpoint', () => {
    upsertGroupContextMessage(app, message());
    expect(readGroupContextPage(path(), anchors).status).toBe('ready');
    for (let i = 0; i < 20; i++) {
      upsertGroupContextMessage(app, message({ messageId: `om_checkpoint_${i}` }));
    }
    const db = openDatabaseSyncOrThrow(path());
    try { expect(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()).toMatchObject({ busy: 0 }); }
    finally { db.close(); }
  });
});
