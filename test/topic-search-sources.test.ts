import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enumerateSources, readJsonlPage, readTopicSession, readTopicSessions, sourceRevision } from '../src/services/topic-search/sources.js';
import { sessionQueueAnchor } from '../src/core/session-message-preview.js';
import { createSession, init, updateSession } from '../src/services/session-store.js';
import type { Session } from '../src/types.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(homedir(), 'topic-sources-'));
  vi.stubEnv('SESSION_DATA_DIR', dataDir);
});
afterEach(() => {
  init('cli_topic_detached', { owner: false });
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

function queue(text: string): string {
  return JSON.stringify({ messageId: 'om_message', rootId: 'om_root', senderId: 'ou_one',
    senderType: 'user', msgType: 'text', content: text, createTime: '1000' }) + '\n';
}
function queueFile(text = queue('中文')) {
  mkdirSync(join(dataDir, 'queues'), { recursive: true });
  writeFileSync(join(dataDir, 'queues/om_root.jsonl'), text);
  return enumerateSources(dataDir, 'queue').files[0];
}

describe('shared session anchor', () => {
  const base = { chatId: 'oc_chat', rootMessageId: 'om_root', scope: 'thread' } satisfies
    Pick<Session, 'chatId' | 'rootMessageId' | 'scope'>;
  it('uses thread root and chat scope, with deferred routing taking precedence over both', () => {
    expect(sessionQueueAnchor(base)).toBe('om_root');
    expect(sessionQueueAnchor({ ...base, scope: 'chat' })).toBe('oc_chat');
    const deferredScheduleRun = { taskId: 'task', turnId: 'turn', routingAnchor: 'schedule_anchor', createdAt: '2026-11-14' };
    for (const scope of ['thread', 'chat'] as const) {
      expect(sessionQueueAnchor({ ...base, scope, deferredScheduleRun })).toBe('schedule_anchor');
    }
  });
});

describe('JSONL byte cursors', () => {
  it('reads a new file, appends, and a split UTF-8 final line without losing or duplicating bytes', () => {
    const first = queue('你好');
    const second = Buffer.from(queue('后续中文'));
    const source = queueFile(first);
    const page = readJsonlPage(source);
    expect(page.reset).toBe(true);
    expect(page.rows.map(row => row.row.value)).toMatchObject([{ content: '你好' }]);
    expect(page.cursor?.offset).toBe(Buffer.byteLength(first));
    const cut = second.indexOf(Buffer.from('中')) + 1;
    appendFileSync(source.path, second.subarray(0, cut));
    const partial = readJsonlPage(source, page.cursor);
    expect(partial.rows).toEqual([]);
    expect(partial.cursor?.offset).toBe(page.cursor?.offset);
    appendFileSync(source.path, second.subarray(cut));
    const completed = readJsonlPage(source, partial.cursor);
    expect(completed.reset).toBe(false);
    expect(completed.rows.map(row => row.row.value)).toMatchObject([{ content: '后续中文' }]);
    expect(completed.rows[0].offset).toBe(Buffer.byteLength(first));
    expect(readJsonlPage(source, completed.cursor).rows).toEqual([]);
  });

  it('restarts on truncation or replacement inode, and reports deletion', () => {
    const source = queueFile(queue('a long first message'));
    const initial = readJsonlPage(source);
    writeFileSync(source.path, queue('x'));
    const truncated = readJsonlPage(source, initial.cursor);
    expect(truncated.reset).toBe(true);
    expect(truncated.rows.map(row => row.row.value)).toMatchObject([{ content: 'x' }]);
    writeFileSync(`${source.path}.replacement`, queue('replacement message larger than x'));
    renameSync(`${source.path}.replacement`, source.path);
    const replaced = readJsonlPage(source, truncated.cursor);
    expect(replaced.reset).toBe(true);
    expect(replaced.rows[0].offset).toBe(0);
    rmSync(source.path);
    expect(readJsonlPage(source, replaced.cursor)).toMatchObject({ status: 'absent', reset: true });
    expect(enumerateSources(dataDir, 'queue').files).toEqual([]);
  });

  it('counts bad JSON and bad shapes and continues after them', () => {
    const source = queueFile('{broken\nnull\n[]\n{"messageId":42}\n' + queue('safe'));
    const before = { bytes: readFileSync(source.path), stat: statSync(source.path) };
    const page = readJsonlPage(source);
    expect(page.malformedLines).toBe(4);
    expect(page.rows.map(row => row.row.value)).toMatchObject([{ content: 'safe' }]);
    expect(page.cursor?.offset).toBe(before.stat.size);
    expect(readFileSync(source.path)).toEqual(before.bytes);
    expect(statSync(source.path).mtimeMs).toBe(before.stat.mtimeMs);
  });

  it('reads reply markers', () => {
    mkdirSync(join(dataDir, 'turn-sends'));
    writeFileSync(join(dataDir, 'turn-sends/session_one.jsonl'), JSON.stringify({
      sessionId: 'session_one', sentAtMs: 1000, previewText: 'answer'.repeat(100), messageId: 'om_reply',
    }) + '\n');
    const source = enumerateSources(dataDir, 'turn_sends').files[0];
    const page = readJsonlPage(source);
    expect(page.rows.map(row => row.row)).toMatchObject([{ kind: 'reply', value: { previewText: 'answer'.repeat(100) } }]);
    expect(page.hasMore).toBe(false);
  });

  it('preserves reply contentHash and skips bodyless markers without counting them as malformed', () => {
    mkdirSync(join(dataDir,'turn-sends'));
    writeFileSync(join(dataDir,'turn-sends/session_one.jsonl'), [
      { sessionId: 'session_one',sentAtMs: 1000,contentHash: 'body_hash',previewText: 'answer' },
      { sessionId: 'session_one',sentAtMs: 1001,contentHash: 'empty_hash' },
    ].map(row => JSON.stringify(row)+'\n').join(''));
    const page = readJsonlPage(enumerateSources(dataDir,'turn_sends').files[0]);
    expect(page.malformedLines).toBe(0);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].row.value).toMatchObject({ contentHash: 'body_hash',previewText: 'answer' });
  });

  it('skips symlinks, directories, invalid basenames and linked source directories', () => {
    const source = queueFile();
    symlinkSync(source.path, join(dataDir, 'queues/linked.jsonl'));
    writeFileSync(join(dataDir, 'queues/bad.name.jsonl'), queue('invalid'));
    mkdirSync(join(dataDir, 'queues/directory.jsonl'));
    const found = enumerateSources(dataDir, 'queue');
    expect(found.files.map(file => file.key)).toEqual(['om_root']);
    expect(found.skipped).toBe(3);
    // A discovered path replaced by a link is rejected again at read time.
    renameSync(source.path, join(dataDir, 'original'));
    symlinkSync(join(dataDir, 'original'), source.path);
    expect(readJsonlPage(source).status).toBe('unreadable');
    rmSync(join(dataDir, 'queues'), { recursive: true });
    symlinkSync(join(dataDir), join(dataDir, 'queues'));
    expect(enumerateSources(dataDir, 'queue')).toMatchObject({ files: [], skipped: 1 });
  });

  it('includes WAL changes in SQLite source revisions', () => {
    const source = queueFile();
    const before = sourceRevision(source.path);
    writeFileSync(`${source.path}-wal`, 'wal bytes');
    expect(sourceRevision(source.path)).toMatchObject({ ...before, wal: { size: 9 } });
  });
});

describe('read-only session metadata', () => {
  it('enumerates all apps and statuses, point-reads fresh rows, and reports unmigrated stores without importing them', () => {
    init('cli_topic_a');
    const active = createSession('oc_a', 'om_a', 'active', 'group', 'thread');
    const closed = createSession('oc_b', 'om_b', 'closed', 'group', 'thread');
    closed.status = 'closed';
    updateSession(closed);
    init('cli_topic_b');
    const other = createSession('oc_c', 'om_c', 'other', 'group', 'chat');
    init('cli_topic_detached', { owner: false });
    writeFileSync(join(dataDir, 'sessions-cli_legacy.json'), '{not imported');
    const snapshot = readTopicSessions(dataDir);
    expect(snapshot.sessions.map(row => [row.sessionId, row.status])).toEqual(expect.arrayContaining([
      [active.sessionId, 'active'], [closed.sessionId, 'closed'], [other.sessionId, 'active'],
    ]));
    expect(snapshot.unmigratedAppIds).toContain('cli_legacy');
    expect(readFileSync(join(dataDir, 'sessions-cli_legacy.json'), 'utf8')).toBe('{not imported');
    expect(readTopicSession(dataDir, other.sessionId)?.scope).toBe('chat');
    expect(readTopicSession(dataDir, active.sessionId, 'cli_topic_b')).toBeUndefined();
    init('cli_topic_a');
    active.title = 'fresh title';
    updateSession(active);
    init('cli_topic_detached', { owner: false });
    expect(readTopicSession(dataDir, active.sessionId)?.title).toBe('fresh title');
    expect(readTopicSession(dataDir, 'missing')).toBeUndefined();
    expect(enumerateSources(dataDir, 'session_store').files).toHaveLength(2);
  });
});
