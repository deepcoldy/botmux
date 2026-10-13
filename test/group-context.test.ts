import { describe, expect, it, vi } from 'vitest';
import { createGroupContextPreparer, groupContextQuery, type GroupContextPreparationDeps } from '../src/services/group-context.js';
import type { GroupContextRenderMessage } from '../src/services/group-context-render.js';

const row = (messageId: string, text: string, seq: number, createTime = '100') => ({
  messageId, text, seq, createTime, chatId: 'oc_room', senderId: 'ou_user',
  senderType: 'user' as const, msgType: 'text', conversationScope: 'main' as const,
});
const request = { appId: 'cli_b', chatId: 'oc_room', turnId: 'om_now', query: '最终计划', createTime: 200 };

function fixture(overrides: Partial<GroupContextPreparationDeps> = {}) {
  const records: GroupContextRenderMessage[] = [];
  let prepared: any;
  const deps: GroupContextPreparationDeps = {
    settings: () => ({ enabled: true, maxContextChars: 12_000 }),
    readPrepared: () => prepared,
    writePrepared: value => (prepared ??= value),
    backfill: vi.fn(async () => ({ messages: [row('om_only_a', '取消蒸汽火车，保留瀑布', 1)], incomplete: false })),
    ingest: message => { records.push({ ...message, seq: records.length + 1 }); },
    readLocal: () => ({ messages: records, incomplete: false }),
    deliveredSeqs: () => [],
    now: () => 250,
    ...overrides,
  };
  return { deps, records, prepare: createGroupContextPreparer(deps) };
}

describe('automatic group context preparation', () => {
  it('uses later stable topic evidence without leaking its future body or the older topic body into main', async () => {
    const records = [{ ...row('om_old_topic', 'OLD_TOPIC_SECRET', 1), conversationScope: undefined },
      { ...row('om_old_topic', 'FUTURE_TOPIC_SECRET', 2), threadId: 'omt_topic', rootId: 'om_topic',
        conversationScope: 'thread' as const, updateTime: 300 }];
    const make = () => fixture({ backfill: async () => ({ messages: [], incomplete: false }),
      readLocal: () => ({ messages: records, incomplete: false }) });
    const lobby = await make().prepare({ ...request, scope: 'main' });
    expect(lobby?.body).toBe('');
    const topic = await make().prepare({ ...request, scope: 'thread', rootId: 'om_topic', threadId: 'omt_topic' });
    expect(topic?.body).toContain('OLD_TOPIC_SECRET');
    expect(topic?.body).not.toContain('FUTURE_TOPIC_SECRET');
  });
  it('isolates lobby text and attachments while preserving proven main quote replies', async () => {
    const resolveAttachments = vi.fn(async () => ({ attachments: [], incomplete: false }));
    const f = fixture({ backfill: async () => ({ messages: [], incomplete: false }), resolveAttachments,
      readLocal: () => ({ messages: [
        { ...row('om_main', 'LOBBY', 1), conversationScope: 'main' as const },
        { ...row('om_quote', 'MAIN_QUOTE', 2), rootId: 'om_topic', conversationScope: 'main' as const },
        { ...row('om_topic_reply', 'TOPIC_PRIVATE', 3), rootId: 'om_topic', threadId: 'omt_topic', conversationScope: 'thread' as const,
          resourceRefs: [{ type: 'image', key: 'img_topic_private' }] },
      ], incomplete: false }),
    });
    const result = await f.prepare({ ...request, scope: 'main' });
    expect(result?.body).toContain('LOBBY');
    expect(result?.body).toContain('MAIN_QUOTE');
    expect(result?.body).not.toContain('TOPIC_PRIVATE');
    expect(resolveAttachments.mock.calls[0][1].map((item: any) => item.messageId)).toEqual(['om_main', 'om_quote']);
  });

  it('a topic receives its starter and own replies without lobby or sibling content', async () => {
    const f = fixture({ backfill: async () => ({ messages: [], incomplete: false }),
      readLocal: () => ({ messages: [
        { ...row('om_topic', 'TOPIC_STARTER', 1), conversationScope: 'main' as const },
        { ...row('om_own_reply', 'OWN_TOPIC', 2), threadId: 'omt_topic', conversationScope: 'thread' as const },
        { ...row('om_main', 'LOBBY_PRIVATE', 3), conversationScope: 'main' as const },
        { ...row('om_sibling', 'SIBLING_PRIVATE', 4), rootId: 'om_other', threadId: 'omt_other', conversationScope: 'thread' as const },
      ], incomplete: false }),
    });
    const result = await f.prepare({ ...request, scope: 'thread', rootId: 'om_topic', threadId: 'omt_topic' });
    expect(result?.body).toContain('TOPIC_STARTER');
    expect(result?.body).toContain('OWN_TOPIC');
    expect(result?.body).not.toMatch(/LOBBY_PRIVATE|SIBLING_PRIVATE/);
  });
  it('supplies an unmentioned discussion before the newly addressed turn without a model/history command', async () => {
    const f = fixture();
    const result = await f.prepare(request);
    expect(result?.body).toContain('取消蒸汽火车');
    expect(result?.body).toContain('om_only_a');
    expect(result?.turnId).toBe('om_now');
    expect(result?.incomplete).toBe(false);
  });

  it('does no I/O when disabled or outside a real group', async () => {
    const f = fixture({ settings: () => ({ enabled: false, maxContextChars: 4000 }) });
    expect(await f.prepare(request)).toBeUndefined();
    expect(f.deps.backfill).not.toHaveBeenCalled();
    const g = fixture();
    expect(await g.prepare({ ...request, chatId: 'http_async_1' })).toBeUndefined();
    expect(g.deps.backfill).not.toHaveBeenCalled();
  });

  it('freezes retry context, excluding the current request and later conversation', async () => {
    const f = fixture({ backfill: vi.fn(async () => ({ messages: [
      row('om_past', 'old decision', 1), row('om_now', 'current request', 2, '200'),
      row('om_future', 'future decision', 3, '201'),
    ], incomplete: false })) });
    const first = await f.prepare(request);
    const retry = await f.prepare({ ...request, createTime: 900, query: 'different retry text' });
    expect(retry).toEqual(first);
    expect(first?.body).toContain('old decision');
    expect(first?.body).not.toContain('current request');
    expect(first?.body).not.toContain('future decision');
    expect(f.deps.backfill).toHaveBeenCalledTimes(1);
  });

  it('rejects foreign-chat backfill rows instead of importing them into the current group', async () => {
    const f = fixture({ backfill: async () => ({ messages: [{ ...row('om_private', 'PRIVATE', 1), chatId: 'oc_other' }], incomplete: false }) });
    const result = await f.prepare(request);
    expect(result?.body).not.toContain('PRIVATE');
    expect(f.records).toHaveLength(0);
  });

  it('preserves local observations but marks failed backfill as incomplete', async () => {
    const f = fixture({ backfill: async () => { throw new Error('network unavailable'); } });
    f.records.push(row('om_cached', 'cached user choice', 1));
    const result = await f.prepare(request);
    expect(result?.incomplete).toBe(true);
    expect(result?.body).toContain('cached user choice');
    expect(result?.body).toContain('incomplete="true"');
  });

  it('does not hang a user turn when history never resolves', async () => {
    const f = fixture({ backfill: () => new Promise(() => {}), timeoutMs: 15 });
    const result = await f.prepare(request);
    expect(result?.incomplete).toBe(true);
    expect(result?.body).toBe('');
  });

  it('carries retention and scan limits rather than silently claiming full history', async () => {
    const f = fixture({
      backfill: async () => ({ messages: [], incomplete: true, reason: 'scan_limit' }),
      readLocal: () => ({ messages: [row('om_old', 'remaining history', 1)], incomplete: true, reason: 'retention_gap' }),
    });
    const result = await f.prepare(request);
    expect(result?.incomplete).toBe(true);
    expect(result?.body).toContain('retention_gap');
    expect(result?.body).toContain('scan_limit');
  });

  it('isolates already delivered sequences by the requested consumer and epoch', async () => {
    const deliveredSeqs = vi.fn(() => [1]);
    const f = fixture({ deliveredSeqs });
    await f.prepare({ ...request, sessionId: 'session_b', epoch: 'native_new' });
    expect(deliveredSeqs).toHaveBeenCalledWith('cli_b', 'oc_room', 'session_b', 'native_new');
  });

  it('omits covered history and does not download its attachments again', async () => {
    const resolveAttachments = vi.fn(async () => ({ attachments: [], incomplete: false }));
    const f = fixture({ deliveredSeqs: () => [1], resolveAttachments });
    const result = await f.prepare({ ...request, sessionId: 'session_b', epoch: 'native_one' });
    expect(result?.body).toBe('');
    expect(result?.includedSeqs).toEqual([]);
    expect(resolveAttachments).not.toHaveBeenCalled();
  });

  it('hydrates only unseen latest revisions and freezes native input coverage separately', async () => {
    const resolveAttachments = vi.fn(async () => ({ attachments: [], incomplete: false }));
    const f = fixture({
      backfill: async () => ({ messages: [], incomplete: false }),
      readLocal: () => ({ messages: [row('om_old', 'old', 1), row('om_old', 'latest', 3), row('om_fresh', 'new', 4), row('om_now', 'edited after native capture', 6)], incomplete: false }),
      deliveredSeqs: () => [3], resolveAttachments,
    });
    const result = await f.prepare({ ...request, sessionId: 'session_b', epoch: 'native_one', nativeInputSeqs: [5] });
    expect(resolveAttachments.mock.calls[0][1].map((message: any) => message.seq)).toEqual([4]);
    expect(result?.nativeInputSeqs).toEqual([5]);
    expect(result?.includedSeqs).toEqual([4]);
    expect(result?.body).not.toContain('edited after native capture');
  });

  it('does not let an old message edited after this request introduce a future decision', async () => {
    const f = fixture({
      backfill: async () => ({ messages: [], incomplete: false }),
      readLocal: () => ({ messages: [
        { ...row('om_choice', 'cancel the mountain', 1), revision: 1, updateTime: 150, observedAt: 151 },
        { ...row('om_choice', 'future: book the mountain', 2), revision: 2, updateTime: 205, observedAt: 206 },
      ], incomplete: false }),
    });
    const value = await f.prepare(request);
    expect(value?.body).toContain('cancel the mountain');
    expect(value?.body).not.toContain('future: book the mountain');
    expect(value?.incomplete).toBe(true);
  });

  it('marks unversioned revisions observed after the trigger as ambiguous', async () => {
    const f = fixture({
      backfill: async () => ({ messages: [], incomplete: false }),
      readLocal: () => ({ messages: [
        { ...row('om_choice', 'earlier choice', 1), revision: 0, observedAt: 151 },
        { ...row('om_choice', 'ambiguous later choice', 2), revision: 1, observedAt: 206 },
      ], incomplete: false }),
    });
    const value = await f.prepare(request);
    expect(value?.body).not.toContain('ambiguous later choice');
    expect(value?.incomplete).toBe(true);
  });
  it('prepares task-bearing topic headers and configured triggers, but not native controls', () => {
    expect(groupContextQuery('/t 整理刚才的讨论')).toBe('整理刚才的讨论');
    expect(groupContextQuery('/topic 整理刚才的讨论')).toBe('整理刚才的讨论');
    expect(groupContextQuery('/solve 整理刚才的讨论', { configuredTrigger: true, renderedPrompt: '请整理刚才的讨论' })).toBe('请整理刚才的讨论');
    expect(groupContextQuery('/compact')).toBeUndefined();
    expect(groupContextQuery('/context-sharing off')).toBeUndefined();
  });
});
