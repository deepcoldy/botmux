import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncTopicIndex } from '../src/services/topic-search/index-store.js';
import { searchTopics } from '../src/services/topic-search/query.js';
import { createSession, init, updateSession } from '../src/services/session-store.js';

let dataDir: string;
const bots = [
  { larkAppId: 'cli_notes_a', name: 'alpha', brand: 'lark' },
  { larkAppId: 'cli_notes_b', name: 'beta', brand: 'feishu' },
] satisfies NonNullable<Parameters<typeof searchTopics>[2]>;

beforeEach(() => {
  dataDir = mkdtempSync(join(homedir(), 'topic-query-notes-'));
  vi.stubEnv('SESSION_DATA_DIR', dataDir);
});
afterEach(() => {
  init('cli_notes_detached', { owner: false });
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});
function topic(anchor: string, app = 'cli_notes_a', activeAt = 2000) {
  init(app);
  const session = createSession('oc_chat', anchor, 'topic title', 'group', 'thread');
  session.lastMessageAt = new Date(activeAt).toISOString();
  updateSession(session);
  init('cli_notes_detached', { owner: false });
  return session;
}
function queue(anchor: string, id: string, text: string, time: number) {
  mkdirSync(join(dataDir, 'queues'), { recursive: true });
  writeFileSync(join(dataDir, 'queues', `${anchor}.jsonl`), JSON.stringify({
    messageId: id, content: text, createTime: time, senderType: 'user',
  }) + '\n');
}
function replies(fileSessionId: string, rows: Array<{
  sessionId: string; messageId: string; previewText: string; sentAtMs: number; targetRootMessageId?: string;
}>) {
  mkdirSync(join(dataDir, 'turn-sends'), { recursive: true });
  writeFileSync(join(dataDir, 'turn-sends', `${fileSessionId}.jsonl`), rows.map(row => JSON.stringify(row) + '\n').join(''));
}
function search(query: string, options: Omit<Parameters<typeof searchTopics>[1], 'query'> = {}) {
  return searchTopics(dataDir, { query, ...options }, bots);
}

describe('topic query notes and filtered limits characterization', () => {
  it('reports a missing reply session even when the topic has another session, but not for resolved replies', async () => {
    const own = topic('om_root');
    const known = { sessionId: own.sessionId, messageId: 'om_known', previewText: 'needle valid', sentAtMs: 1000 };
    replies(own.sessionId, [known]);
    await syncTopicIndex(dataDir);
    expect(search('needle').results[0].notes).not.toContain('meta_missing');

    replies(own.sessionId, [known, { sessionId: 'missing_session', messageId: 'om_orphan',
      previewText: 'needle orphan', sentAtMs: 2000, targetRootMessageId: 'om_root' }]);
    await syncTopicIndex(dataDir);
    const result = search('needle').results[0];
    expect(result.sessions.map(session => session.sessionId)).toContain(own.sessionId);
    expect(result.hits.count).toBe(2);
    expect(result.notes).toContain('meta_missing');
    expect(search('valid').results[0].notes).not.toContain('meta_missing');
  });

  it('keeps reply_truncated and the full count when the older truncated reply is outside hits one', async () => {
    const own = topic('om_root');
    queue('om_root', 'om_newer', 'needle latest inbound', 3000);
    replies(own.sessionId, [{ sessionId: own.sessionId, messageId: 'om_older',
      previewText: 'needle older reply…', sentAtMs: 1000 }]);
    await syncTopicIndex(dataDir);
    const result = search('needle', { hits: 1 }).results[0];
    expect(result.hits.count).toBe(2);
    expect(result.hits.items).toHaveLength(1);
    expect(result.hits.items[0].messageId).toBe('om_newer');
    expect(result.notes).toContain('reply_truncated');
    expect(result.notes).not.toContain('meta_missing');
  });

  it('ranks before limiting and computes truncated from bot-filtered topics', async () => {
    topic('om_a', 'cli_notes_a', 3000);
    topic('om_b', 'cli_notes_a', 2000);
    topic('om_c', 'cli_notes_a', 3000);
    topic('om_excluded', 'cli_notes_b', 9000);
    for (const anchor of ['om_a', 'om_b', 'om_c']) queue(anchor, `${anchor}_message`, 'needle ranking', 2000);
    queue('om_excluded', 'om_excluded_message', 'needle ranking', 9000);
    await syncTopicIndex(dataDir);
    const limited = search('needle', { bot: 'alpha', limit: 2 });
    expect(limited.results.map(result => result.anchor)).toEqual(['om_a', 'om_c']);
    expect(limited.truncated).toBe(true);
    const complete = search('needle', { bot: 'alpha', limit: 3 });
    expect(complete.results.map(result => result.anchor)).toEqual(['om_a', 'om_c', 'om_b']);
    expect(complete.truncated).toBe(false);
    expect(search('needle', { bot: 'cli_notes_a', limit: 2 })).toEqual(limited);
  });
});
