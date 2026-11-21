import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDispatchTaskTreeCards, DISPATCH_TASK_TREE_CARDS_FILE, isTaskTreeCardGone, THREAD_ID_RETRY_MS } from '../src/services/dispatch-task-tree-card.js';
import { MessageUpdateExpiredError, MessageWithdrawnError } from '../src/im/lark/client.js';
import { TopicSendError } from '../src/cli/topic-send-guard.js';

class Gone extends Error {}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const ORCH = { sessionId: 'orch', larkAppId: 'cli_local', chatId: 'oc_chat', rootMessageId: 'om_orch', title: '主任务' };

function setup(registry: Record<string, unknown> = {
  om_a: { orchSessionId: 'orch', targetAppIds: ['cli_local'], targetChatId: 'oc_x', title: 'A', status: 'accepted', createdAt: '1' },
}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'task-tree-'));
  roots.push(dataDir);
  writeFileSync(join(dataDir, 'orchestrate-dispatch.json'), JSON.stringify(registry));
  const posts: string[] = [];
  let lookups = 0;
  let now = Date.parse('2026-11-03T00:00:00Z');
  const updates: string[] = [];
  let gone = new Set<string>();
  let n = 0;
  const deps = {
    dataDir,
    listSessions: () => [],
    localAppIds: () => new Set(['cli_local']),
    resolveThreadId: async (_app: string, root: string) => { lookups += 1; return root === 'om_a' ? 'omt_a' : null; },
    now: () => new Date(now),
    post: async () => { await new Promise(r => setTimeout(r, 5)); const id = `om_card_${++n}`; posts.push(id); return id; },
    update: async (_app: string, id: string) => { if (gone.has(id)) throw new Gone(); updates.push(id); },
    isMessageGone: (e: unknown) => e instanceof Gone,
    brand: () => 'feishu' as const,
    log: () => {},
  };
  return { dataDir, deps, posts, updates, lookups: () => lookups, advance: (ms: number) => { now += ms; }, markGone: (id: string) => { gone = new Set([...gone, id]); } };
}

describe('task-tree card service', () => {
  it('posts once, then patches the same card', async () => {
    const s = setup();
    const cards = createDispatchTaskTreeCards(s.deps);
    const first = await cards.refresh(ORCH);
    const second = await cards.refresh(ORCH);
    expect(first).toMatchObject({ posted: true, messageId: 'om_card_1' });
    expect(second).toMatchObject({ posted: false, messageId: 'om_card_1' });
    expect(s.posts).toEqual(['om_card_1']);
    expect(s.updates).toEqual(['om_card_1']);
  });

  it('two concurrent first refreshes post a single card', async () => {
    const s = setup();
    const cards = createDispatchTaskTreeCards(s.deps);
    await Promise.all([cards.refresh(ORCH), cards.refresh(ORCH), cards.refresh(ORCH)]);
    expect(s.posts).toHaveLength(1);
  });

  it('the card survives a daemon restart (state on disk)', async () => {
    const s = setup();
    await createDispatchTaskTreeCards(s.deps).refresh(ORCH);
    await createDispatchTaskTreeCards(s.deps).refresh(ORCH);
    expect(s.posts).toEqual(['om_card_1']);
  });

  it('reposts when the card was withdrawn', async () => {
    const s = setup();
    const cards = createDispatchTaskTreeCards(s.deps);
    await cards.refresh(ORCH);
    s.markGone('om_card_1');
    expect(await cards.refresh(ORCH)).toMatchObject({ posted: true, messageId: 'om_card_2' });
    await cards.refresh(ORCH);
    expect(s.updates).toEqual(['om_card_2']);
  });

  it('does not post for a session with no dispatches, nor when posting is not allowed', async () => {
    const empty = setup({});
    expect(await createDispatchTaskTreeCards(empty.deps).refresh(ORCH)).toMatchObject({ posted: false });
    const s = setup();
    expect(await createDispatchTaskTreeCards(s.deps).refresh(ORCH, { allowPost: false })).toMatchObject({ posted: false });
    expect([...empty.posts, ...s.posts]).toEqual([]);
  });

  it('keeps the requirement for later refreshes', async () => {
    const s = setup();
    const cards = createDispatchTaskTreeCards(s.deps);
    await cards.refresh(ORCH, { requirement: { id: 'REQ-9', url: 'https://example.com/9' } });
    const later = await cards.refresh(ORCH);
    expect(later.tree.requirement).toEqual({ id: 'REQ-9', url: 'https://example.com/9' });
    expect(later.tree.nodes[0]!.threadId).toBe('omt_a');
  });

  it('a failing update that is not "gone" surfaces and does not repost', async () => {
    const s = setup();
    const cards = createDispatchTaskTreeCards({ ...s.deps, update: async () => { throw new Error('rate limited'); } });
    await cards.refresh(ORCH);
    await expect(cards.refresh(ORCH)).rejects.toThrow('rate limited');
    expect(s.posts).toHaveLength(1);
  });

  it('an unreadable card store blocks posting instead of posting a new card every time', async () => {
    const s = setup();
    writeFileSync(join(s.dataDir, DISPATCH_TASK_TREE_CARDS_FILE), '{not json');
    const cards = createDispatchTaskTreeCards(s.deps);
    for (let i = 0; i < 3; i += 1) await expect(cards.refresh(ORCH)).rejects.toThrow();
    expect(s.posts).toEqual([]);
  });

  it('does not look up an unresolvable thread again until the retry window passes', async () => {
    const s = setup({
      om_a: { orchSessionId: 'orch', targetAppIds: ['cli_local'], title: 'A', status: 'accepted', createdAt: '1' },
      om_b: { orchSessionId: 'orch', targetAppIds: ['cli_local'], title: 'B', status: 'accepted', createdAt: '2' },
      om_f: { orchSessionId: 'orch', targetAppIds: ['cli_local'], title: 'F', status: 'failed', transportState: 'failed', createdAt: '3' },
    });
    const cards = createDispatchTaskTreeCards(s.deps);
    await cards.refresh(ORCH);
    expect(s.lookups()).toBe(2);
    await cards.refresh(ORCH);
    expect(s.lookups()).toBe(2);
    s.advance(THREAD_ID_RETRY_MS);
    await cards.refresh(ORCH);
    expect(s.lookups()).toBe(3);
  });

  it('retries saving a just-posted card id once instead of posting again next time', async () => {
    const s = setup();
    const real = await import('../src/core/dispatch-registry.js');
    let failures = 1;
    const cards = createDispatchTaskTreeCards({ ...s.deps });
    const spy = vi.spyOn(real, 'updateDispatchRegistry');
    spy.mockImplementationOnce(async () => { failures -= 1; throw new Error('lock timeout'); });
    await cards.refresh(ORCH);
    spy.mockRestore();
    await cards.refresh(ORCH);
    expect(failures).toBe(0);
    expect(s.posts).toEqual(['om_card_1']);
  });

  it('narrows the session lookup to this orchestrator\'s own dispatch roots', async () => {
    const s = setup({
      om_a: { orchSessionId: 'orch', targetAppIds: ['cli_local'], title: 'A', status: 'accepted', createdAt: '1' },
      om_other: { orchSessionId: 'someone-else', targetAppIds: ['cli_local'], title: 'B', status: 'accepted', createdAt: '2' },
    });
    const queried: string[] = [];
    const cards = createDispatchTaskTreeCards({
      ...s.deps,
      listSessions: (roots: ReadonlySet<string>) => { queried.push(...roots); return []; },
    });
    await cards.refresh(ORCH);
    expect(queried).toEqual(['om_a']);
  });

  it('reads a getter dataDir lazily on refresh, not at construction', async () => {
    const s = setup();
    let dataDir: string | undefined;
    const cards = createDispatchTaskTreeCards({ ...s.deps, dataDir: () => {
      if (!dataDir) throw new Error('data dir bound later');
      return dataDir;
    } });
    dataDir = s.dataDir;
    expect(await cards.refresh(ORCH)).toMatchObject({ posted: true, messageId: 'om_card_1' });
  });

  it('treats withdrawn, expired and stop-policy-blocked cards as gone; other errors as transient', () => {
    expect(isTaskTreeCardGone(new MessageWithdrawnError('om_x'))).toBe(true);
    expect(isTaskTreeCardGone(new MessageUpdateExpiredError('om_x'))).toBe(true);
    expect(isTaskTreeCardGone(new TopicSendError('TOPIC_SEND_BLOCKED', 'x'))).toBe(true);
    expect(isTaskTreeCardGone(new TopicSendError('TOPIC_SEND_CHECK_FAILED', 'x'))).toBe(false);
    expect(isTaskTreeCardGone(new Error('rate limited'))).toBe(false);
  });
});
