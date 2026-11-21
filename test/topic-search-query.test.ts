import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncTopicIndex, topicIndexPath } from '../src/services/topic-search/index-store.js';
import { parseTopicQuery, searchTopics, showTopic, topicSnippet } from '../src/services/topic-search/query.js';
import { createSession, init, updateSession } from '../src/services/session-store.js';
import { chatAppLink, threadAppLink } from '../src/im/lark/lark-hosts.js';
import { _resetGroupContextStoreForTest, upsertGroupContextMessage } from '../src/services/group-context-store.js';
import { OutputDeliveryJournal } from '../src/services/output-delivery-journal.js';
import { outputSnapshot } from '../src/services/universal-output-handoff.js';

let dataDir: string;
let journal: OutputDeliveryJournal | undefined;
const bots = [{ larkAppId: 'cli_query_a',name: 'alpha',brand: 'lark' as const },
  { larkAppId: 'cli_query_b',name: 'beta',brand: 'feishu' as const }];
beforeEach(() => {
  dataDir = mkdtempSync(join(homedir(),'topic-query-'));
  vi.stubEnv('SESSION_DATA_DIR',dataDir);
});
afterEach(() => {
  journal?.close(); journal = undefined; _resetGroupContextStoreForTest();
  init('cli_detached',{ owner: false }); vi.unstubAllEnvs();
  rmSync(dataDir,{ recursive: true,force: true });
});
function queue(anchor: string, rows: { id: string; text: string; time?: number }[]) {
  mkdirSync(join(dataDir,'queues'),{ recursive: true });
  writeFileSync(join(dataDir,'queues',`${anchor}.jsonl`),rows.map(row => JSON.stringify({
    messageId: row.id,content: row.text,createTime: row.time ?? 1000,senderId: 'ou_sender',senderType: 'user',
  })+'\n').join(''));
}
function topic(anchor: string, options: { app?: string; scope?: 'thread'|'chat'; activeAt?: number; closed?: boolean; threadId?: string } = {}) {
  init(options.app ?? 'cli_query_a');
  const session = createSession(options.scope === 'chat' ? anchor : 'oc_chat',anchor,'topic title','group',options.scope ?? 'thread');
  Object.assign(session,{ larkThreadId: options.threadId,chatDisplayName: 'display chat',cliId: 'codex',
    lastMessageAt: new Date(options.activeAt ?? 2000).toISOString(),status: options.closed ? 'closed' : 'active' });
  updateSession(session); init('cli_detached',{ owner: false }); return session;
}
function search(query: string, options: Omit<Parameters<typeof searchTopics>[1],'query'> = {}) {
  return searchTopics(dataDir,{ query,...options },bots);
}

describe('topic query validation and snippets', () => {
  it('normalizes query whitespace and rejects empty, oversized or controlled input and invalid options', () => {
    expect(parseTopicQuery({ query: ['  first','second  '] })).toMatchObject({ query: 'first second',terms: ['first','second'] });
    for (const query of ['', ' '.repeat(10),'x'.repeat(201),'foo\nbar','x\u0000y']) {
      expect(() => parseTopicQuery({ query })).toThrow();
    }
    expect(() => parseTopicQuery({ query: 'valid',limit: 101 })).toThrow();
    expect(() => parseTopicQuery({ query: 'valid',hits: 0 })).toThrow();
    expect(() => parseTopicQuery({ query: 'valid',since: 'invalid' })).toThrow();
    expect(() => parseTopicQuery({ query: 'valid',since: 2,until: 1 })).toThrow();
  });

  it('centers on a literal match, compacts whitespace and preserves Unicode code points within 160 characters', () => {
    const snippet = topicSnippet('😀'.repeat(180)+'  needle\nmatch  '+'😀'.repeat(180),['needle']);
    expect(snippet).toContain('needle match');
    expect(Array.from(snippet).length).toBeLessThanOrEqual(160);
    expect(snippet.startsWith('…')).toBe(true); expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(topicSnippet(' short\nbody ',['body'])).toBe('short body');
  });
});

describe('FTS and LIKE topic search', () => {
  it('matches one/two-character Chinese words and mixed text, with AND across separate messages of a topic', async () => {
    topic('om_one'); topic('om_two');
    queue('om_one',[{ id: 'om_first',text: '风险研判 TaskAlpha',time: 1000 },{ id: 'om_second',text: 'N1 回答',time: 2000 }]);
    queue('om_two',[{ id: 'om_other',text: '风险研判 TaskAlpha',time: 3000 }]);
    await syncTopicIndex(dataDir);
    expect(search('险').results).toHaveLength(2);
    expect(search('风险').results).toHaveLength(2);
    expect(search('taskalpha N1').results.map(result => result.anchor)).toEqual(['om_one']);
    expect(search('TaskAlpha N1').results[0].hits).toMatchObject({ count: 2,items: [
      { messageId: 'om_second' },{ messageId: 'om_first' },
    ] });
    expect(search('不存在').results).toEqual([]);
  });

  it('treats FTS operators and LIKE wildcard characters as literal text', async () => {
    const literals = ['OR','NEAR','*','"','(',')','a"b','foo*bar','100%','a_b','\\'];
    for (let i = 0; i < literals.length; i++) queue(`om_literal_${i}`,[{ id: `om_message_${i}`,text: `prefix ${literals[i]} suffix` }]);
    queue('om_wildcard_decoy',[{ id: 'om_decoy',text: 'prefix 100x aXb a-quote-b suffix' }]);
    queue('om_operator_phrase',[{ id: 'om_phrase',text: 'prefix " OR " suffix' }]);
    await syncTopicIndex(dataDir);
    for (const literal of literals) {
      const results = search(literal).results;
      expect(results.some(result => result.anchor === `om_literal_${literals.indexOf(literal)}`),literal).toBe(true);
    }
    expect(search('100%').results.map(result => result.anchor)).toEqual(['om_literal_8']);
    expect(search('a_b').results.map(result => result.anchor)).toEqual(['om_literal_9']);
    expect(search('" OR "').results.map(result => result.anchor)).toEqual(['om_operator_phrase']);
  });

  it('orders by last matching time, topic activity and anchor and returns only the requested hits/topics', async () => {
    topic('om_a',{ activeAt: 3000 }); topic('om_b',{ activeAt: 2000 }); topic('om_c',{ activeAt: 3000 });
    queue('om_a',[{ id: 'om_a1',text: 'ranking needle',time: 1000 },{ id: 'om_a2',text: 'ranking needle',time: 2000 }]);
    queue('om_b',[{ id: 'om_b1',text: 'ranking needle',time: 2000 }]);
    queue('om_c',[{ id: 'om_c1',text: 'ranking needle',time: 2000 }]);
    await syncTopicIndex(dataDir);
    expect(search('needle').results.map(result => result.anchor)).toEqual(['om_a','om_c','om_b']);
    const limited = search('needle',{ limit: 1,hits: 1 });
    expect(limited.truncated).toBe(true);
    expect(limited.results[0].hits).toMatchObject({ count: 2,items: [{ messageId: 'om_a2' }] });
    expect(limited.results[0].hits.items).toHaveLength(1);
  });

  it('filters document times and bot participation without requiring the matching message to come from that bot', async () => {
    topic('om_alpha'); topic('om_beta',{ app: 'cli_query_b' });
    queue('om_alpha',[{ id: 'om_a',text: 'needle',time: 1000 }]);
    queue('om_beta',[{ id: 'om_b',text: 'needle',time: 3000 }]);
    await syncTopicIndex(dataDir);
    expect(search('needle',{ since: 2000 }).results.map(result => result.anchor)).toEqual(['om_beta']);
    expect(search('needle',{ until: '1970-01-01T00:00:02.000Z' }).results.map(result => result.anchor)).toEqual(['om_alpha']);
    expect(search('needle',{ bot: 'alpha' }).results.map(result => result.anchor)).toEqual(['om_alpha']);
    expect(search('needle',{ bot: 'cli_query_b' }).results.map(result => result.anchor)).toEqual(['om_beta']);
    expect(search('needle',{ bot: 'unknown' }).results).toEqual([]);
  });

  it('orders equal-time hits by source kind and keeps titles from multiple sessions on one anchor', async () => {
    const own = topic('om_root');
    init('cli_query_a'); own.title = 'needle title'; own.createdAt = new Date(1000).toISOString(); updateSession(own); init('cli_detached',{ owner: false });
    topic('om_root',{ app: 'cli_query_b',closed: true });
    queue('om_root',[{ id: 'om_inbound',text: 'needle inbound',time: 1000 }]);
    mkdirSync(join(dataDir,'turn-sends'));
    writeFileSync(join(dataDir,`turn-sends/${own.sessionId}.jsonl`),JSON.stringify({ sessionId: own.sessionId,messageId: 'om_reply',sentAtMs: 1000,previewText: 'needle reply' })+'\n');
    upsertGroupContextMessage('cli_query_a',{ messageId: 'om_group',chatId: 'oc_chat',rootId: 'om_root',threadId: 'omt_thread',
      conversationScope: 'thread',senderId: 'ou_sender',senderType: 'user',msgType: 'text',text: 'needle group',createTime: 1000,resourceRefs: [],sourceAppId: 'cli_query_a' });
    journal = new OutputDeliveryJournal(dataDir,'cli_query_a');
    const snapshot = outputSnapshot('cli_query_a',{ type: 'final_output',sessionId: own.sessionId,turnId: 'turn',lastUuid: 'uuid',content: 'needle final' },1000);
    journal.accept(snapshot,{ kind: 'im',context: { target: { mode: 'thread',rootMessageId: 'om_root' } },chatId: 'oc_chat',chatType: 'group' });
    journal.claim(snapshot.id,'owner'); journal.complete(snapshot.id,'owner',{ status: 'delivered',messageId: 'om_final' });
    await syncTopicIndex(dataDir);
    const result = search('needle',{ hits: 20 }).results[0];
    expect(result.hits.items.map(hit => hit.kind)).toEqual(['final','group','inbound','reply','title']);
    expect(result.sessions).toHaveLength(2); expect(result.status).toBe('open');
    expect(showTopic(dataDir,'om_root',200,bots)?.documents.filter(doc => doc.kind === 'title')).toHaveLength(2);
  });

  it('generates native thread and chat links using the owning bot brand and reads current session status', async () => {
    const own = topic('om_thread',{ threadId: 'omt_native' });
    topic('oc_chat_scope',{ scope: 'chat',app: 'cli_query_b' });
    queue('om_thread',[{ id: 'om_thread_message',text: 'needle' }]);
    queue('oc_chat_scope',[{ id: 'om_chat_message',text: 'needle' }]);
    await syncTopicIndex(dataDir);
    expect(search('needle').results.find(result => result.anchor === 'om_thread')).toMatchObject({
      link: threadAppLink('oc_chat','omt_native','lark'),chatName: 'display chat',status: 'open',
    });
    expect(search('needle').results.find(result => result.anchor === 'oc_chat_scope')?.link)
      .toBe(chatAppLink('oc_chat_scope','feishu'));
    init('cli_query_a'); own.status = 'closed'; own.title = 'renamed title'; updateSession(own); init('cli_detached',{ owner: false });
    // No synchronization: display metadata must already reflect the current row.
    expect(search('needle').results.find(result => result.anchor === 'om_thread')).toMatchObject({
      status: 'closed',title: 'renamed title',notes: ['replies_removed_on_close'],
    });
  });

  it('reports missing metadata and truncated replies, lists full documents in time order, and keeps source/index files unchanged', async () => {
    queue('om_missing',[{ id: 'om_seed',text: 'first inbound needle',time: 1000 }]);
    mkdirSync(join(dataDir,'turn-sends'));
    writeFileSync(join(dataDir,'turn-sends/missing_session.jsonl'),JSON.stringify({ sessionId: 'missing_session',
      messageId: 'om_reply',targetRootMessageId: 'om_missing',sentAtMs: 2000,previewText: 'needle reply…' })+'\n');
    await syncTopicIndex(dataDir);
    const path = topicIndexPath(dataDir); const before = readFileSync(path); const mtime = statSync(path).mtimeMs;
    const source = join(dataDir,'queues/om_missing.jsonl'); const sourceBefore = readFileSync(source); const sourceTime = statSync(source).mtimeMs;
    expect(search('needle').results[0]).toMatchObject({ title: 'first inbound needle',link: null,notes: ['meta_missing','reply_truncated'] });
    const shown = showTopic(dataDir,'om_reply',200,bots);
    expect(shown?.documents.map(doc => doc.message_id)).toEqual(['om_seed','om_reply']);
    expect(shown?.documents[1].text).toBe('needle reply…');
    expect(showTopic(dataDir,'om_missing',1,bots)?.truncated).toBe(true);
    expect(showTopic(dataDir,'om_absent',200,bots)).toBeUndefined();
    expect(readFileSync(path)).toEqual(before); expect(statSync(path).mtimeMs).toBe(mtime);
    expect(readFileSync(source)).toEqual(sourceBefore); expect(statSync(source).mtimeMs).toBe(sourceTime);
  });

  it('restricts visible anchors before ranking and bounds candidate materialization', async () => {
    topic('om_newest'); const visible = topic('om_visible'); topic('om_oldest');
    queue('om_newest',[{ id: 'om_n',text: 'needle newest',time: 3000 }]);
    queue('om_visible',[{ id: 'om_v',text: 'needle visible',time: 2000 }]);
    queue('om_oldest',[{ id: 'om_o',text: 'needle oldest',time: 1000 }]);
    await syncTopicIndex(dataDir);
    expect(searchTopics(dataDir,{ query: 'needle',limit: 1 },bots,{ anchors: new Set(['om_visible']) }).results)
      .toEqual([expect.objectContaining({ anchor: 'om_visible' })]);
    expect(searchTopics(dataDir,{ query: 'needle',limit: 1 },bots,{ visibleSessionIds: new Set([visible.sessionId]) }).results)
      .toEqual([expect.objectContaining({ anchor: 'om_visible' })]);
    expect(searchTopics(dataDir,{ query: 'needle' },bots,{ anchors: new Set() }).results).toEqual([]);

    queue('om_many',Array.from({ length: 30 },(_,i) => ({ id: `om_many_${i}`,text: 'budget needle',time: i+1 })));
    await syncTopicIndex(dataDir);
    const full = searchTopics(dataDir,{ query: 'budget',hits: 20 },bots).results.find(result => result.anchor === 'om_many');
    const bounded = searchTopics(dataDir,{ query: 'budget',hits: 20 },bots,{ candidateLimit: 5 });
    expect(full?.hits.count).toBe(30);
    expect(bounded.results.find(result => result.anchor === 'om_many')?.hits.count).toBe(5);
    expect(bounded.truncated).toBe(true);
  });
});
