import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openTopicIndex, syncTopicIndex, topicIndexPath } from '../src/services/topic-search/index-store.js';
import { searchTopics, showTopic } from '../src/services/topic-search/query.js';
import { docSchema } from '../src/services/topic-search/documents.js';
import { createSession, init, updateSession } from '../src/services/session-store.js';
import * as sourceReaders from '../src/services/topic-search/sources.js';
import * as groupReader from '../src/services/topic-search/group-context.js';
import * as outputReader from '../src/services/topic-search/output-journal.js';
import { _resetGroupContextStoreForTest, groupContextDbPath, markGroupContextMessageDeleted,
  pruneGroupContext, upsertGroupContextMessage } from '../src/services/group-context-store.js';
import { OutputDeliveryJournal } from '../src/services/output-delivery-journal.js';
import { outputSnapshot } from '../src/services/universal-output-handoff.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

let dataDir: string;
let journal: OutputDeliveryJournal | undefined;
const app = 'cli_topic_index';
beforeEach(() => {
  dataDir = mkdtempSync(join(homedir(),'topic-index-'));
  vi.stubEnv('SESSION_DATA_DIR',dataDir);
});
afterEach(() => {
  journal?.close(); journal = undefined;
  _resetGroupContextStoreForTest(); init('cli_detached',{ owner: false });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(dataDir,{ recursive: true,force: true });
});
function jsonl(relative: string, rows: unknown[]) {
  const path = join(dataDir,relative); mkdirSync(join(path,'..'),{ recursive: true });
  writeFileSync(path,rows.map(row => JSON.stringify(row)+'\n').join('')); return path;
}
function inbound(messageId = 'om_message',content = 'inbound body') {
  return { messageId,content,senderType: 'user',senderId: 'ou_sender',createTime: '1000' };
}
function session(root = 'om_root') {
  init(app); const value = createSession('oc_chat',root,'topic title','group','thread');
  init('cli_detached',{ owner: false }); return value;
}
function group(text: string,messageId = 'om_message',extra: { msgType?: string; cardContentVersion?: number } = {}) {
  return upsertGroupContextMessage(app,{ messageId,chatId: 'oc_chat',rootId: 'om_root',threadId: 'omt_thread',
    conversationScope: 'thread',senderId: 'ou_sender',senderType: 'user',msgType: 'text',text,
    createTime: Date.now(),resourceRefs: [],sourceAppId: app,...extra });
}
function documents() {
  const db = openTopicIndex(dataDir,{ readOnly: true });
  try { return db.prepare('SELECT * FROM docs ORDER BY id').all().map(row => docSchema.parse(row)); }
  finally { db.close(); }
}

describe('topic index synchronization and merge', () => {
  it('increments byte cursors, leaves half-lines for later, and commits bounded pages', async () => {
    const path = jsonl('queues/om_root.jsonl',Array.from({ length: 2200 },(_,i) => inbound(`om_${i}`,'正文'.repeat(100))));
    await syncTopicIndex(dataDir);
    expect(documents()).toHaveLength(2200);
    appendFileSync(path,JSON.stringify(inbound('om_partial','half')));
    await syncTopicIndex(dataDir);
    expect(documents()).toHaveLength(2200);
    appendFileSync(path,'\n{broken\n');
    const result = await syncTopicIndex(dataDir);
    expect(result.malformedLines).toBe(1);
    expect(documents()).toHaveLength(2201);
    const db = openTopicIndex(dataDir,{ readOnly: true });
    try { expect(db.prepare('SELECT offset FROM sources WHERE path=?').get('queues/om_root.jsonl')).toMatchObject({ offset: statSync(path).size }); }
    finally { db.close(); }
  });

  it('rebuilds multi-line truncated or replaced JSONL files and removes deleted sources', async () => {
    const path = jsonl('queues/om_root.jsonl',[inbound('om_old_1','old one'),inbound('om_old_2','old two'),inbound('om_old_3','old three')]);
    await syncTopicIndex(dataDir);
    writeFileSync(path,JSON.stringify(inbound('om_new','new'))+'\n');
    await syncTopicIndex(dataDir);
    expect(documents().map(doc => doc.message_id)).toEqual(['om_new']);
    const replacement = jsonl('queues/replacement.jsonl',[inbound('om_replaced','different inode')]);
    renameSync(replacement,path);
    await syncTopicIndex(dataDir);
    expect(documents().map(doc => doc.message_id)).toEqual(['om_replaced']);
    rmSync(path); await syncTopicIndex(dataDir);
    expect(documents()).toEqual([]);
  });

  it('detects same-size and regrown in-place rewrites from the consumed cursor fingerprint', async () => {
    const path = jsonl('queues/om_root.jsonl',[inbound('om_old1','aaaa'),inbound('om_old2','bbbb')]);
    await syncTopicIndex(dataDir);
    const size = statSync(path).size;
    writeFileSync(path,[inbound('om_new1','cccc'),inbound('om_new2','dddd')].map(row => JSON.stringify(row)+'\n').join(''));
    expect(statSync(path).size).toBe(size);
    utimesSync(path,new Date(),new Date(Date.now()+1000));
    await syncTopicIndex(dataDir);
    expect(documents().map(doc => doc.message_id)).toEqual(['om_new1','om_new2']);
    writeFileSync(path,[inbound('om_regrown_1','regrown '.repeat(20)),inbound('om_regrown_2','content '.repeat(20))]
      .map(row => JSON.stringify(row)+'\n').join(''));
    expect(statSync(path).size).toBeGreaterThan(size);
    utimesSync(path,new Date(),new Date(Date.now()+2000));
    await syncTopicIndex(dataDir);
    expect(documents().map(doc => doc.message_id)).toEqual(['om_regrown_1','om_regrown_2']);
  });

  it('detects an earlier-line rewrite when the final line and revision metadata are unchanged', async () => {
    const path = jsonl('queues/om_root.jsonl',[inbound('om_first','OLD_FIRST'),inbound('om_last','UNCHANGED_LAST')]);
    // Pin a whole-second mtime before the first sync so the index records it. A
    // sub-microsecond mtime does not survive the seconds-based utimesSync round-trip
    // on every filesystem (CI storage truncates to microseconds), which would make
    // the metadata-identity guard below flake. Integer seconds round-trip exactly.
    const pinnedSeconds = Math.floor(Date.now()/1000);
    utimesSync(path,pinnedSeconds,pinnedSeconds);
    await syncTopicIndex(dataDir);
    const { size,mtimeMs } = statSync(path);
    writeFileSync(path,[inbound('om_first','NEW_FIRST'),inbound('om_last','UNCHANGED_LAST')].map(row => JSON.stringify(row)+'\n').join(''));
    utimesSync(path,mtimeMs/1000,mtimeMs/1000);
    expect(statSync(path)).toMatchObject({ size,mtimeMs });
    await syncTopicIndex(dataDir);
    expect(documents().map(doc => ({ message_id: doc.message_id,text: doc.text }))).toEqual([
      { message_id: 'om_first',text: 'NEW_FIRST' },{ message_id: 'om_last',text: 'UNCHANGED_LAST' },
    ]);
    expect(searchTopics(dataDir,{ query: 'OLD_FIRST' }).results).toEqual([]);
    expect(searchTopics(dataDir,{ query: 'NEW_FIRST' }).results).toHaveLength(1);
  });

  it('a rebuild landing between two output-journal pages of another sync keeps every final answer', async () => {
    const own = session();
    for (let queue = 0; queue < 3; queue++) {
      jsonl(`queues/om_race_${queue}.jsonl`,Array.from({ length: 3 },(_,row) =>
        inbound(`om_race_${queue}_${row}`,'rebuild race queue')));
    }
    journal = new OutputDeliveryJournal(dataDir,app);
    for (let i = 0; i < 2001; i++) {
      const snapshot = outputSnapshot(app,{ type: 'final_output',sessionId: own.sessionId,
        turnId: `turn_race_${i}`,lastUuid: `uuid_race_${i}`,content: `final answer ${i}` });
      journal.accept(snapshot,{ kind: 'im',context: { target: { mode: 'thread',rootMessageId: 'om_root' } },
        chatId: 'oc_chat',chatType: 'group' });
      journal.claim(snapshot.id,'owner');
      journal.complete(snapshot.id,'owner',{ status: 'delivered',messageId: `om_final_race_${i}` });
    }
    const readPage = outputReader.readOutputJournalPage;
    let rebuild: ReturnType<typeof syncTopicIndex> | undefined;
    let scheduled = false;
    vi.spyOn(outputReader,'readOutputJournalPage').mockImplementation((...args) => {
      const page = readPage(...args);
      if (!scheduled) {
        scheduled = true;
        setImmediate(() => { rebuild = syncTopicIndex(dataDir,{ rebuild: true }); });
      }
      return page;
    });
    await syncTopicIndex(dataDir);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(rebuild).toBeDefined();
    await rebuild;
    expect(documents().filter(doc => doc.kind === 'final')).toHaveLength(2001);
  },30_000);

  it('merges duplicate messages and falls back through remaining sources when each higher source disappears', async () => {
    const own = session();
    jsonl('queues/om_root.jsonl',[inbound()]);
    jsonl(`turn-sends/${own.sessionId}.jsonl`,[{ sessionId: own.sessionId,messageId: 'om_message',sentAtMs: 2000,previewText: 'reply body' }]);
    group('group body');
    journal = new OutputDeliveryJournal(dataDir,app);
    const snapshot = outputSnapshot(app,{ type: 'final_output',sessionId: own.sessionId,turnId: 'turn_one',lastUuid: 'uuid',content: 'final complete body' });
    journal.accept(snapshot,{ kind: 'im',context: { target: { mode: 'thread',rootMessageId: 'om_root' } },chatId: 'oc_chat',chatType: 'group' });
    journal.claim(snapshot.id,'owner'); journal.complete(snapshot.id,'owner',{ status: 'delivered',messageId: 'om_message' });
    await syncTopicIndex(dataDir);
    let merged = documents().filter(doc => doc.message_id === 'om_message');
    expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject({ kind: 'final',text: 'final complete body' });
    expect(merged[0].sources).toEqual(['final','group','inbound','reply']);
    const filename = journal.filename; journal.close(); journal = undefined; rmSync(filename);
    await syncTopicIndex(dataDir); expect(showTopic(dataDir,'om_message')?.documents.find(doc => doc.message_id === 'om_message')?.kind).toBe('group');
    expect(searchTopics(dataDir,{ query: 'complete' }).results).toEqual([]);
    _resetGroupContextStoreForTest(); rmSync(groupContextDbPath(app));
    await syncTopicIndex(dataDir); expect(documents().find(doc => doc.message_id === 'om_message')?.kind).toBe('inbound');
    // Equal-priority inbound/reply ties have a deterministic winner; remove inbound to expose reply.
    rmSync(join(dataDir,'queues/om_root.jsonl'));
    await syncTopicIndex(dataDir); expect(documents().find(doc => doc.message_id === 'om_message')?.kind).toBe('reply');
  });

  it('deduplicates queue copies and message-id-less replies using contentHash', async () => {
    jsonl('queues/om_root.jsonl',[inbound()]); jsonl('queues/om_copy.jsonl',[inbound()]);
    const reply = { sessionId: 's',sentAtMs: 2000,previewText: 'reply',contentHash: 'same_hash',targetChatId: 'oc_chat' };
    jsonl('turn-sends/s.jsonl',[reply,reply,{ ...reply,contentHash: 'different_hash' }]);
    await syncTopicIndex(dataDir);
    expect(documents().filter(doc => doc.message_id === 'om_message')).toHaveLength(1);
    expect(documents().filter(doc => doc.kind === 'reply')).toHaveLength(2);
    expect((await syncTopicIndex(dataDir)).processedSources).toBe(0);
  });

  it('indexes a journal row settled within the same millisecond and keeps the scan idempotent', async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date,'now').mockReturnValue(now);
    journal = new OutputDeliveryJournal(dataDir,app);
    const snapshot = outputSnapshot(app,{ type: 'final_output',sessionId: 'missing_session',turnId: 'turn_one',lastUuid: 'uuid',content: 'same millisecond answer' });
    journal.accept(snapshot,{ kind: 'im',context: { target: { mode: 'thread',rootMessageId: 'om_root' } },chatId: 'oc_chat',chatType: 'group' });
    await syncTopicIndex(dataDir); expect(documents()).toEqual([]);
    journal.claim(snapshot.id,'owner'); journal.complete(snapshot.id,'owner',{ status: 'delivered',messageId: 'om_final' });
    await syncTopicIndex(dataDir,{ paths: [`output-delivery-journals/${app}.db`] });
    expect(documents()).toMatchObject([{ kind: 'final',anchor: 'om_root',text: 'same millisecond answer' }]);
    await syncTopicIndex(dataDir);
    expect(documents()).toHaveLength(1);
    const db = openTopicIndex(dataDir,{ readOnly: true });
    try {
      expect(db.prepare('SELECT cursor_updated_at,wal_size FROM sources WHERE path=?').get(`output-delivery-journals/${app}.db`))
        .toMatchObject({ cursor_updated_at: now,wal_size: expect.any(Number) });
    } finally { db.close(); }
  });

  it('uses current session rows for implicit replies and preserves explicit targets when metadata appears', async () => {
    const own = session('om_correct');
    renameSync(join(dataDir,'session-stores',app),join(dataDir,'saved_store'));
    jsonl(`turn-sends/${own.sessionId}.jsonl`,[{ sessionId: own.sessionId,sentAtMs: 2000,previewText: 'explicit body',targetRootMessageId: 'om_explicit' }]);
    await syncTopicIndex(dataDir);
    expect(searchTopics(dataDir,{ query: 'explicit' }).results[0]).toMatchObject({ anchor: 'om_explicit',notes: ['meta_missing'] });
    renameSync(join(dataDir,'saved_store'),join(dataDir,'session-stores',app));
    await syncTopicIndex(dataDir);
    expect(searchTopics(dataDir,{ query: 'explicit' }).results[0].anchor).toBe('om_explicit');
    const fresh = session('om_fresh');
    jsonl(`turn-sends/${fresh.sessionId}.jsonl`,[{ sessionId: fresh.sessionId,sentAtMs: 3000,previewText: 'implicit point read' }]);
    await syncTopicIndex(dataDir,{ paths: [`turn-sends/${fresh.sessionId}.jsonl`] });
    expect(searchTopics(dataDir,{ query: 'implicit' }).results[0].anchor).toBe('om_fresh');
  });

  it('corrects implicit reply anchors in place after a metadata change without replaying sources or restarting group scans', async () => {
    const own = session('om_fallback');
    jsonl(`turn-sends/${own.sessionId}.jsonl`,[{ sessionId: own.sessionId,messageId: 'om_reply',sentAtMs: 2000,previewText: 'reply body' }]);
    const pending = group('group body');
    await syncTopicIndex(dataDir);
    const db = openTopicIndex(dataDir);
    const sql = "SELECT id,kind,anchor FROM entries WHERE kind IN ('reply','final') ORDER BY kind";
    const rowSchema = z.object({ id: z.number(),kind: z.string(),anchor: z.string() });
    const before = db.prepare(sql).all().map(row => rowSchema.parse(row));
    try {
      expect(before).toEqual([expect.objectContaining({ kind: 'reply',anchor: 'om_fallback' })]);
      db.exec("CREATE TRIGGER reject_reply_rebuild BEFORE DELETE ON entries WHEN OLD.kind IN ('reply','final') BEGIN SELECT RAISE(ABORT,'entry_must_survive_metadata_change'); END");
    } finally { db.close(); }
    init(app); own.rootMessageId = 'om_root'; updateSession(own); init('cli_detached',{ owner: false });
    const snapshots = vi.spyOn(sourceReaders,'readTopicSessions');
    const points = vi.spyOn(sourceReaders,'readTopicSession');
    const jsonlReads = vi.spyOn(sourceReaders,'readJsonlPage');
    const journalReads = vi.spyOn(outputReader,'readOutputJournalPage');
    const groupReads = vi.spyOn(groupReader,'readGroupContextPage');
    await syncTopicIndex(dataDir);
    expect(snapshots).toHaveBeenCalledTimes(1); expect(points).not.toHaveBeenCalled();
    expect(jsonlReads).toHaveBeenCalledTimes(1); expect(jsonlReads.mock.results[0]?.value.rows).toEqual([]);
    expect(journalReads).not.toHaveBeenCalled();
    expect(groupReads.mock.calls.some(call => call[2]?.pendingSeqs === undefined && (call[2]?.afterSeq ?? 0) === 0)).toBe(false);
    expect(groupReads.mock.calls.some(call => call[2]?.pendingSeqs?.includes(pending.seq))).toBe(true);
    const check = openTopicIndex(dataDir,{ readOnly: true });
    try {
      expect(check.prepare(sql).all().map(row => rowSchema.parse(row)))
        .toEqual(before.map(row => ({ ...row,anchor: 'om_root' })));
    } finally { check.close(); }
    expect(documents().find(doc => doc.kind === 'group')?.anchor).toBe('om_root');
  });

  it('keeps explicit reply/final targets through merges and later source-session metadata changes', async () => {
    const own = session('om_source'); session('om_target');
    jsonl(`turn-sends/${own.sessionId}.jsonl`,[{ sessionId: own.sessionId,messageId: 'om_reply',sentAtMs: 2000,
      previewText: 'explicit reply',targetChatId: 'oc_chat',targetRootMessageId: 'om_target' }]);
    journal = new OutputDeliveryJournal(dataDir,app);
    const final = outputSnapshot(app,{ type: 'final_output',sessionId: own.sessionId,turnId: 'turn',lastUuid: 'uuid',content: 'explicit final' });
    journal.accept(final,{ kind: 'im',context: { target: { mode: 'thread',rootMessageId: 'om_target' } },chatId: 'oc_chat',chatType: 'group' });
    journal.claim(final.id,'owner'); journal.complete(final.id,'owner',{ status: 'delivered',messageId: 'om_final' });
    upsertGroupContextMessage(app,{ messageId: 'om_final',chatId: 'oc_chat',rootId: 'om_target',threadId: 'omt_thread',
      conversationScope: 'thread',senderId: app,senderType: 'bot',msgType: 'text',text: 'explicit final',createTime: 3000,resourceRefs: [],sourceAppId: app });
    await syncTopicIndex(dataDir);
    expect(searchTopics(dataDir,{ query: 'explicit' }).results.map(result => result.anchor)).toEqual(['om_target']);
    init(app); own.rootMessageId = 'om_moved'; updateSession(own); init('cli_detached',{ owner: false });
    await syncTopicIndex(dataDir);
    expect(searchTopics(dataDir,{ query: 'explicit' }).results.map(result => result.anchor)).toEqual(['om_target']);
    const db = openTopicIndex(dataDir,{ readOnly: true });
    try {
      expect(db.prepare("SELECT kind,anchor,anchor_explicit FROM entries WHERE kind IN ('reply','final') ORDER BY kind").all())
        .toEqual([{ kind: 'final',anchor: 'om_target',anchor_explicit: 1 },{ kind: 'reply',anchor: 'om_target',anchor_explicit: 1 }]);
    } finally { db.close(); }
  });

  it('compares titles individually, leaves unchanged titles untouched, and omits empty or deleted sessions', async () => {
    init(app);
    const stable = createSession('oc_chat','om_stable','stable title','group','thread');
    const changed = createSession('oc_chat','om_changed','before title','group','thread');
    const empty = createSession('oc_chat','om_empty','   ','group','thread');
    const removed = createSession('oc_chat','om_removed','removed title','group','thread');
    init('cli_detached',{ owner: false });
    await syncTopicIndex(dataDir);
    const db = openTopicIndex(dataDir);
    const titleRows = "SELECT id,session_id,anchor,text,time_ms FROM entries WHERE kind='title' ORDER BY session_id";
    const titleSchema = z.object({ id: z.number(),session_id: z.string(),anchor: z.string(),text: z.string(),time_ms: z.number().nullable() });
    const before = db.prepare(titleRows).all().map(row => titleSchema.parse(row));
    try {
      expect(before.some(row => row.session_id === empty.sessionId)).toBe(false);
      // Even an unchanged UPSERT would trip this trigger; a metadata-only change must not rewrite the title.
      db.exec("CREATE TRIGGER reject_stable_title BEFORE INSERT ON entries WHEN NEW.kind='title' AND NEW.text='stable title' BEGIN SELECT RAISE(ABORT,'unchanged_title_rewritten'); END");
    } finally { db.close(); }
    init(app);
    stable.lastMessageAt = new Date().toISOString(); updateSession(stable);
    changed.title = 'after title'; changed.rootMessageId = 'om_moved'; changed.createdAt = new Date(1000).toISOString(); updateSession(changed);
    init('cli_detached',{ owner: false });
    // Remove a row from a real-writer fixture to represent metadata retention.
    const store = openDatabaseSyncOrThrow(join(dataDir,'session-stores',app,'sessions.db'));
    try { store.prepare('DELETE FROM sessions WHERE session_id=?').run(removed.sessionId); } finally { store.close(); }
    await syncTopicIndex(dataDir);
    const check = openTopicIndex(dataDir,{ readOnly: true });
    try {
      const after = check.prepare(titleRows).all().map(row => titleSchema.parse(row));
      expect(after.find(row => row.session_id === stable.sessionId)).toEqual(before.find(row => row.session_id === stable.sessionId));
      expect(after.find(row => row.session_id === changed.sessionId)).toEqual({
        ...before.find(row => row.session_id === changed.sessionId),anchor: 'om_moved',text: 'after title',time_ms: 1000,
      });
      expect(after.map(row => row.session_id).sort()).toEqual([stable.sessionId,changed.sessionId].sort());
    } finally { check.close(); }
  });

  it('point-reads each distinct session only once across replies and finals in a targeted synchronization', async () => {
    const own = session();
    const replyPath = `turn-sends/${own.sessionId}.jsonl`;
    const path = jsonl(replyPath,[0,1,2,3].map(i => ({ sessionId: i < 2 ? own.sessionId : 'missing_session',
      sentAtMs: 2000+i,previewText: `reply ${i}`,messageId: `om_reply_${i}`,targetRootMessageId: 'om_fallback' })));
    journal = new OutputDeliveryJournal(dataDir,app);
    for (const turnId of ['turn_one','turn_two']) {
      const final = outputSnapshot(app,{ type: 'final_output',sessionId: own.sessionId,turnId,lastUuid: 'uuid',content: 'final body' });
      journal.accept(final,{ kind: 'im',context: { target: { mode: 'thread',rootMessageId: 'om_root' } },chatId: 'oc_chat',chatType: 'group' });
      journal.claim(final.id,'owner'); journal.complete(final.id,'owner',{ status: 'delivered',messageId: `om_${turnId}` });
    }
    const snapshots = vi.spyOn(sourceReaders,'readTopicSessions');
    const points = vi.spyOn(sourceReaders,'readTopicSession');
    await syncTopicIndex(dataDir,{ paths: [replyPath,`output-delivery-journals/${app}.db`] });
    expect(snapshots).not.toHaveBeenCalled();
    expect(points.mock.calls.map(call => call[1]).sort()).toEqual([own.sessionId,'missing_session'].sort());
    points.mockClear();
    appendFileSync(path,JSON.stringify({ sessionId: own.sessionId,sentAtMs: 3000,previewText: 'next invocation' })+'\n');
    await syncTopicIndex(dataDir,{ paths: [replyPath] });
    expect(points.mock.calls.map(call => call[1])).toEqual([own.sessionId]);
  });

  it('does not parse session snapshots during an unchanged full check', async () => {
    session(); await syncTopicIndex(dataDir);
    const snapshots = vi.spyOn(sourceReaders,'readTopicSessions');
    await syncTopicIndex(dataDir);
    expect(snapshots).not.toHaveBeenCalled();
  });

  it('skips a corrupt session store without deleting its titles or blocking healthy sources', async () => {
    session(); await syncTopicIndex(dataDir);
    const before = documents().filter(doc => doc.kind === 'title');
    // macOS persistent WAL can mask corruption of the main database file.
    rmSync(join(dataDir,'session-stores',app,'sessions.db-wal'),{ force: true });
    rmSync(join(dataDir,'session-stores',app,'sessions.db-shm'),{ force: true });
    writeFileSync(join(dataDir,'session-stores',app,'sessions.db'),'corrupt sqlite');
    jsonl('queues/om_healthy.jsonl',[inbound('om_healthy','healthy source')]);
    const result = await syncTopicIndex(dataDir);
    expect(result.skipped).toBeGreaterThan(0);
    expect(documents().filter(doc => doc.kind === 'title')).toEqual(before);
    expect(documents().some(doc => doc.message_id === 'om_healthy')).toBe(true);
  });

  it('rechecks cards on each synchronization but leaves no_session pending alone until metadata changes', async () => {
    const missing = group('waiting for local session','om_waiting');
    const card = group('card body','om_card',{ msgType: 'interactive' });
    await syncTopicIndex(dataDir);
    const db = openTopicIndex(dataDir);
    try {
      // Protect the existing no_session row while the independently pending card is reread.
      db.exec(`CREATE TRIGGER reject_pending_delete BEFORE DELETE ON gc_pending WHEN OLD.seq=${missing.seq}
        BEGIN SELECT RAISE(ABORT,'no_session_rechecked_without_metadata_change'); END`);
      db.exec(`CREATE TRIGGER reject_pending_insert BEFORE INSERT ON gc_pending WHEN NEW.seq=${missing.seq}
        BEGIN SELECT RAISE(ABORT,'no_session_reinserted_without_metadata_change'); END`);
    } finally { db.close(); }
    const reads = vi.spyOn(groupReader,'readGroupContextPage');
    await syncTopicIndex(dataDir);
    expect(reads.mock.calls.flatMap(call => call[2]?.pendingSeqs ?? [])).toEqual([card.seq]);
    group('card body','om_card',{ msgType: 'interactive',cardContentVersion: 1 });
    await syncTopicIndex(dataDir);
    reads.mockClear();
    // Both rows now wait only for a session; an unchanged group source must be skipped completely.
    await syncTopicIndex(dataDir);
    expect(reads).not.toHaveBeenCalled();
    const unlock = openTopicIndex(dataDir);
    try { unlock.exec('DROP TRIGGER reject_pending_delete; DROP TRIGGER reject_pending_insert'); } finally { unlock.close(); }
    session(); reads.mockClear(); await syncTopicIndex(dataDir);
    expect(reads.mock.calls.some(call => call[2]?.pendingSeqs === undefined && (call[2]?.afterSeq ?? 0) === 0)).toBe(false);
    expect(reads.mock.calls.flatMap(call => call[2]?.pendingSeqs ?? [])).toEqual([missing.seq,card.seq]);
    expect(documents().filter(doc => doc.kind === 'group').map(doc => doc.message_id).sort()).toEqual(['om_card','om_waiting']);
  });

  it('retries metadata backfill after a failed call even when sessions.db has not changed again', async () => {
    group('recover pending message','om_recovery');
    await syncTopicIndex(dataDir);
    session();
    const reads = vi.spyOn(groupReader,'readGroupContextPage');
    reads.mockImplementationOnce(() => { throw new Error('injected_backfill_failure'); });
    await expect(syncTopicIndex(dataDir)).rejects.toThrow('injected_backfill_failure');
    await syncTopicIndex(dataDir);
    expect(documents().find(doc => doc.message_id === 'om_recovery')?.kind).toBe('group');
  });

  it('suppresses recalled messages across sources and restores remaining sources when the recall source disappears', async () => {
    session(); jsonl('queues/om_root.jsonl',[inbound('om_message','withdrawn')]); group('withdrawn');
    await syncTopicIndex(dataDir); markGroupContextMessageDeleted(app,'oc_chat','om_message');
    await syncTopicIndex(dataDir);
    expect(searchTopics(dataDir,{ query: 'withdrawn' }).results).toEqual([]);
    _resetGroupContextStoreForTest(); rmSync(groupContextDbPath(app));
    await syncTopicIndex(dataDir);
    expect(searchTopics(dataDir,{ query: 'withdrawn' }).results).toHaveLength(1);
  });

  it('updates edits, verifies cards in place, admits newly created topics, and reconciles retention', async () => {
    group('initial text'); await syncTopicIndex(dataDir);
    expect(documents()).toEqual([]);
    session(); await syncTopicIndex(dataDir);
    expect(searchTopics(dataDir,{ query: 'initial' }).results).toHaveLength(1);
    group('edited text'); await syncTopicIndex(dataDir);
    expect(searchTopics(dataDir,{ query: 'initial' }).results).toEqual([]);
    expect(searchTopics(dataDir,{ query: 'edited' }).results).toHaveLength(1);
    const card = group('verified card','om_card',{ msgType: 'interactive' });
    await syncTopicIndex(dataDir); expect(showTopic(dataDir,'om_card')).toBeUndefined();
    const verified = group('verified card','om_card',{ msgType: 'interactive',cardContentVersion: 1 });
    expect(verified.seq).toBe(card.seq); await syncTopicIndex(dataDir);
    expect(showTopic(dataDir,'om_card')).toBeDefined();
    pruneGroupContext(app,'oc_chat',{ maxRows: 1,maxAgeMs: 100_000,now: Date.now() });
    await syncTopicIndex(dataDir);
    expect(documents().filter(doc => doc.kind === 'group').map(doc => doc.message_id)).toEqual(['om_card']);
  });

  it('rolls back entry, FTS and cursor changes together when a page fails', async () => {
    const path = jsonl('queues/om_root.jsonl',[inbound('om_old','old')]);
    await syncTopicIndex(dataDir);
    const db = openTopicIndex(dataDir);
    let offset: unknown;
    try {
      offset = db.prepare('SELECT offset FROM sources WHERE path=?').get('queues/om_root.jsonl');
      // Fault injection in the derived test DB, after creating it through the real implementation.
      db.exec("CREATE TRIGGER reject_test_entry BEFORE INSERT ON entries WHEN NEW.text='fail_this_page' BEGIN SELECT RAISE(ABORT,'injected_page_failure'); END");
    } finally { db.close(); }
    appendFileSync(path,JSON.stringify(inbound('om_new','fail_this_page'))+'\n');
    await expect(syncTopicIndex(dataDir)).rejects.toThrow('injected_page_failure');
    const check = openTopicIndex(dataDir);
    try {
      expect(check.prepare('SELECT offset FROM sources WHERE path=?').get('queues/om_root.jsonl')).toEqual(offset);
      check.exec('DROP TRIGGER reject_test_entry');
    } finally { check.close(); }
    expect(documents().map(doc => doc.message_id)).toEqual(['om_old']);
    await syncTopicIndex(dataDir); expect(documents().map(doc => doc.message_id)).toEqual(['om_old','om_new']);
  });

  it('supports rebuild without unlinking the database and stops only between committed pages', async () => {
    jsonl('queues/om_root.jsonl',Array.from({ length: 2200 },(_,i) => inbound(`om_${i}`,'large'.repeat(100))));
    let calls = 0;
    const stopped = await syncTopicIndex(dataDir,{ shouldStop: () => ++calls > 6 });
    expect(stopped.stopped).toBe(true);
    expect(documents().length).toBeGreaterThan(0);
    expect(documents().length).toBeLessThan(2200);
    const inode = statSync(topicIndexPath(dataDir)).ino;
    await syncTopicIndex(dataDir,{ rebuild: true });
    expect(statSync(topicIndexPath(dataDir)).ino).toBe(inode);
    expect(documents()).toHaveLength(2200);
  });
});

describe('topic index ownership and concurrent writers', () => {
  it('rejects foreign and unknown-table databases without modifying them', () => {
    const directory = join(dataDir,'topic-search'); mkdirSync(directory);
    const path = topicIndexPath(dataDir);
    const foreign = openDatabaseSyncOrThrow(path);
    foreign.exec('CREATE TABLE private_data(value TEXT)'); foreign.close();
    const before = readFileSync(path); const mtime = statSync(path).mtimeMs;
    expect(() => openTopicIndex(dataDir)).toThrow('foreign_topic_index');
    expect(readFileSync(path)).toEqual(before); expect(statSync(path).mtimeMs).toBe(mtime);
    rmSync(path); const own = openTopicIndex(dataDir); own.exec('CREATE TABLE unfamiliar(value TEXT)'); own.close();
    expect(() => openTopicIndex(dataDir)).toThrow('unknown_topic_index_table');
  });

  it('rebuilds only derived tables on a schema-version mismatch and preserves fractional file times', async () => {
    const queue = jsonl('queues/om_root.jsonl',[inbound()]);
    utimesSync(queue,1_800_000_000.123456,1_800_000_000.123456);
    await syncTopicIndex(dataDir);
    const inode = statSync(topicIndexPath(dataDir)).ino;
    expect(statSync(topicIndexPath(dataDir)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir,'topic-search')).mode & 0o777).toBe(0o700);
    const db = openTopicIndex(dataDir);
    expect(db.prepare('SELECT mtime_ms FROM sources WHERE path=?').get('queues/om_root.jsonl'))
      .toMatchObject({ mtime_ms: statSync(queue).mtimeMs });
    db.exec('PRAGMA user_version=999'); db.close();
    const rebuilt = openTopicIndex(dataDir);
    try {
      expect(rebuilt.prepare('SELECT COUNT(*) AS n FROM docs').get()).toMatchObject({ n: 0 });
    } finally { rebuilt.close(); }
    expect(statSync(topicIndexPath(dataDir)).ino).toBe(inode);
  });

  it('serializes independent writer processes and leaves one entry/document per appearance', async () => {
    jsonl('queues/om_root.jsonl',Array.from({ length: 30 },(_,i) => inbound(`om_${i}`)));
    const children = [0,1].map(() => spawnTsEvalWithRepoImports(`
      import { syncTopicIndex } from './src/services/topic-search/index-store.js';
      await syncTopicIndex(process.env.SESSION_DATA_DIR);
    `,{ cwd: process.cwd(),env: { ...process.env,SESSION_DATA_DIR: dataDir },stdio: ['ignore','pipe','pipe'],timeout: 20_000 }));
    const cleanup = () => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); };
    try {
      const exits = await Promise.all(children.map(async child => {
        let stderr = ''; child.stderr?.on('data',chunk => { stderr += String(chunk); });
        const [code] = await once(child,'exit'); return { code,stderr };
      }));
      for (const exit of exits) expect(exit.code,exit.stderr).toBe(0);
      const db = openTopicIndex(dataDir,{ readOnly: true });
      try {
        expect(z.object({ n: z.number() }).parse(db.prepare('SELECT COUNT(*) AS n FROM entries').get()).n).toBe(30);
        expect(documents()).toHaveLength(30);
      } finally { db.close(); }
    } finally { cleanup(); }
  },30_000);

  it('releases its read snapshot on close so a live writer can checkpoint', async () => {
    jsonl('queues/om_before.jsonl',[inbound('om_before')]);
    await syncTopicIndex(dataDir);
    const reader = openTopicIndex(dataDir,{ readOnly: true });
    reader.close();
    jsonl('queues/om_after.jsonl',[inbound('om_after')]);
    await syncTopicIndex(dataDir);
    const db = openDatabaseSyncOrThrow(topicIndexPath(dataDir));
    try { expect(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()).toMatchObject({ busy: 0 }); }
    finally { db.close(); }
  });

  // Bun keeps closed connections until GC, retaining shared locks; all index access runs in children.
  it('waits for a transient index lock during queries and writer identity checks', async () => {
    jsonl('queues/om_lock.jsonl',[inbound('om_lock')]);
    const directory = JSON.stringify(dataDir);
    async function runChild(source: string, whileLocked?: () => Promise<void>): Promise<void> {
      const child = spawnTsEvalWithRepoImports(source,{ cwd: process.cwd(),
        env: { ...process.env,SESSION_DATA_DIR: dataDir },stdio: ['ignore','pipe','pipe'] });
      const exited = new Promise<number | null>(resolve => child.once('close',resolve));
      let stderr = '';
      child.stderr?.on('data',data => { stderr += String(data); });
      child.on('error',error => { stderr += error.message; });
      try {
        if (whileLocked) {
          await new Promise<void>((resolve,reject) => {
            let output = '';
            const timer = setTimeout(() => finish(new Error('lock holder did not become ready')),5000);
            const onData = (data: Buffer) => {
              output += data.toString();
              if (output.includes('locked\n')) finish();
            };
            const onClose = () => finish(new Error(`lock holder exited before ready: ${stderr}`));
            const finish = (error?: Error) => {
              clearTimeout(timer);
              child.stdout?.off('data',onData);
              child.off('error',finish);
              child.off('close',onClose);
              if (error) reject(error); else resolve();
            };
            child.stdout?.on('data',onData);
            child.once('error',finish);
            child.once('close',onClose);
          });
          await whileLocked();
        } else { child.stdout?.resume(); }
        expect(await exited,stderr).toBe(0);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
    }
    const indexImport = "import { openTopicIndex,syncTopicIndex } from './src/services/topic-search/index-store.js';";
    await runChild(`${indexImport} await syncTopicIndex(${directory});`);
    for (const operation of [
      `openTopicIndex(${directory},{ readOnly: true }).close();`,
      `await syncTopicIndex(${directory});`,
    ]) {
      await runChild(`
        import { openDatabaseSyncOrThrow } from './src/services/sqlite-compat.js';
        const db = openDatabaseSyncOrThrow(${JSON.stringify(topicIndexPath(dataDir))});
        db.exec('PRAGMA busy_timeout=5000; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE sync_meta SET last_sync_started_at=0 WHERE singleton=1; COMMIT');
        process.stdout.write('locked\\n');
        setTimeout(() => db.close(),3000);
      `,() => runChild(`${indexImport} ${operation}`));
    }
  },30_000);
});
