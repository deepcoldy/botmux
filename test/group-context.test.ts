import { describe, expect, it, vi } from 'vitest';
import { createGroupContextPreparer, groupContextQuery, type GroupContextPreparationDeps } from '../src/services/group-context.js';
import type { GroupContextRenderMessage } from '../src/services/group-context-render.js';

const row = (messageId: string, text: string, seq: number, createTime = '100') => ({
  messageId, text, seq, createTime, chatId: 'oc_room', senderId: 'ou_user',
  senderType: 'user' as const, msgType: 'text',
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
    expect(result?.body).toContain('incomplete="true"');
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
