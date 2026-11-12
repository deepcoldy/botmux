/**
 * 决策看板给本机外部客户端（`botmux owner-board`）的读和提交：真实 DecisionBoardService + 临时库，
 * 投递和卡片换成记录调用的假实现。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionBoardService, boardErrorStatus, type DecisionBoardServiceDeps } from '../src/core/decision-board/service.js';
import { DECISION_CARD_ACTION_PICK } from '../src/core/decision-board/card.js';
import { parseOwnerBoardStates } from '../src/core/decision-board/owner-api.js';
import { decisionAskKey } from '../src/core/decision-board/ask-key.js';
import type { StewardConfig } from '../src/core/decision-board/model.js';

const APP = 'cli_steward';
const OWNER = 'ou_owner';

let dir: string;
let steward: StewardConfig | undefined;
let delivered: Array<Parameters<DecisionBoardServiceDeps['deliver']>[0]>;
let deliverImpl: DecisionBoardServiceDeps['deliver'];
let sent: Array<{ card: any; messageId: string }>;
let service: DecisionBoardService;

function makeService(): DecisionBoardService {
  return new DecisionBoardService({
    dataDir: dir,
    larkAppId: () => APP,
    steward: () => steward,
    locale: () => 'zh',
    brand: () => 'feishu',
    dashboardOrigin: () => 'https://dash.example',
    ownerOpenId: () => OWNER,
    ownerName: async () => '主人',
    timeZone: () => 'UTC',
    batchAttachmentsDir: batchId => join(dir, 'attachments', `board-${batchId}`),
    banner: ({ batchId, count }) => `收到 ${count} 项（#${batchId}）`,
    deliver: input => deliverImpl(input),
    log: () => {},
    lookupChat: async chatId => ({ ok: true, chatId, appId: APP, name: `群 ${chatId}` }),
    cards: {
      sendCard: async (_chatId, card) => {
        const messageId = `om_card_${sent.length + 1}`;
        sent.push({ card: JSON.parse(card), messageId });
        return messageId;
      },
      updateCard: async () => {},
      isCardGone: () => false,
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-board-owner-'));
  steward = { enabled: true, chatId: 'oc_steward' };
  delivered = [];
  deliverImpl = async input => { delivered.push(input); return { sessionId: 'sess-steward' }; };
  sent = [];
  service = makeService();
});
afterEach(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });

async function add(title: string, extra: { state?: string; ask?: string; options?: string[]; links?: string[]; primaryChat?: string } = {}) {
  const res = await service.cli({
    action: 'add', title,
    fields: {
      ...(extra.state ? { state: extra.state } : {}),
      ...(extra.ask ? { question: extra.ask, recommend: 'A', recommendReason: '改动小' } : {}),
      summary: `${title} 的一句话`,
    },
    ...(extra.options ? { options: extra.options } : {}),
    ...(extra.links ? { links: extra.links } : { noChat: '用例里没有群' }),
    ...(extra.primaryChat ? { primaryChat: extra.primaryChat } : {}),
  }, { sessionId: 'sess-1' }) as { item: { seq: number } };
  await service.cardsIdle();
  return res.item.seq;
}

const addDecide = (title = 'PR #1 合不合', links?: string[], primaryChat?: string) => add(title, {
  state: 'decide', ask: '合不合？', options: ['A=合 → 风险小', 'B=不合 → 再等一轮'], links, primaryChat,
});

function errorCode(fn: () => unknown): Promise<string> {
  return Promise.resolve().then(fn).then(
    () => { throw new Error('expected a BoardError'); },
    error => boardErrorStatus(error).error,
  );
}

describe('ownerList / ownerDetail', () => {
  it('默认只列待拍板和待验收，每项带拍板需要的全部字段和链接', async () => {
    const decide = await addDecide('PR #1 合不合', ['chat=oc_review|评审群', 'chat=oc_dev', 'pr=deepcoldy/botmux#12'], 'oc_dev');
    const accept = await add('验收新卡片', { state: 'accept' });
    await add('正在修', { state: 'active' });

    const out = service.ownerList(parseOwnerBoardStates(undefined)!);
    expect(out.larkAppId).toBe(APP);
    expect(out.steward).toEqual({ enabled: true, ready: true, chatId: 'oc_steward' });
    expect(out.states).toEqual(['decide', 'accept']);
    expect(out.items.map(i => i.seq)).toEqual([decide, accept]);

    const item = out.items[0]!;
    expect(item).toMatchObject({
      seq: decide,
      title: 'PR #1 合不合',
      state: 'decide',
      stateLabel: '待拍板',
      summary: 'PR #1 合不合 的一句话',
      question: '合不合？',
      options: [{ key: 'A', label: '合', effect: '风险小' }, { key: 'B', label: '不合', effect: '再等一轮' }],
      recommend: 'A',
      recommendReason: '改动小',
      primaryChatId: 'oc_dev',
      url: `https://dash.example/board/${APP}/${decide}`,
      pendingDecisions: 0,
    });
    expect(item.askKey).toMatch(/^[0-9a-f]{12}$/);
    expect(item.appLink).toContain('mode=sidebar-semi');
    expect(item.appLink).toContain(encodeURIComponent(`https://dash.example/board/${APP}/${decide}`));
    expect(item.links.map(l => [l.kind, l.ref, l.text, l.primary ?? false])).toEqual([
      ['chat', 'oc_review', '评审群', false],
      ['chat', 'oc_dev', '群 oc_dev', true],
      ['pr', 'deepcoldy/botmux#12', expect.any(String), false],
    ]);
    expect(item.links[2]!.url).toBe('https://github.com/deepcoldy/botmux/pull/12');
    expect(item.lastDecision).toBeUndefined();

    expect(service.ownerList(['active']).items.map(i => i.title)).toEqual(['正在修']);
    expect(service.ownerList(parseOwnerBoardStates('all')!).items).toHaveLength(3);
  });

  it('详情带进展和最近历史（最新在前）；没有的编号报 item_not_found', async () => {
    const seq = await addDecide();
    await service.cli({ action: 'set', ref: String(seq), fields: { progress: 'CI 全绿', note: '跑完 CI' } }, { sessionId: 's' });
    const { item } = service.ownerDetail(seq);
    expect(item.progress).toBe('CI 全绿');
    expect(item.events.length).toBeGreaterThan(1);
    expect(item.events[0]!.at).toBeGreaterThanOrEqual(item.events.at(-1)!.at);
    expect(item.events.some(e => e.text.includes('跑完 CI'))).toBe(true);
    for (const e of item.events) expect(e).not.toHaveProperty('actorRef');
    expect(await errorCode(() => service.ownerDetail(999))).toBe('item_not_found');
  });

  it('没开管家的 bot 不列、也不为此建库', async () => {
    steward = undefined;
    expect(await errorCode(() => service.ownerList(['decide']))).toBe('not_steward');
    expect(await errorCode(() => service.ownerDetail(1))).toBe('not_steward');
  });
});

describe('ownerDecide', () => {
  const keyOf = (seq: number) => service.ownerDetail(seq).item.askKey;

  it('建一项一批并走同一条投递进管家会话；列表随后显示这条决定', async () => {
    const seq = await addDecide();
    const askKey = service.ownerList(['decide']).items[0]!.askKey;
    const res = await service.ownerDecide({ seq, askKey, choice: 'A', text: '合吧', requestId: 'req-00000001' });
    expect(res).toEqual({
      duplicate: false,
      decision: { seq, choice: 'A', text: '合吧', handled: false },
      batch: { id: 1, delivery: 'delivered' },
      supersedes: [],
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.turnId).toBe(`board:${APP}:1`);
    expect(delivered[0]!.chatId).toBe('oc_steward');
    expect(delivered[0]!.prompt).toContain(`#${seq} PR #1 合不合`);
    expect(delivered[0]!.prompt).toContain('选：A 合（管家推荐）');
    expect(delivered[0]!.prompt).toContain('来源：本机客户端');
    expect(delivered[0]!.prompt).toContain('合吧');

    const listed = service.ownerList(['decide']).items[0]!;
    expect(listed.pendingDecisions).toBe(1);
    expect(listed.lastDecision).toMatchObject({ batchId: 1, choice: 'A', text: '合吧', delivery: 'delivered', handled: false });
    expect(service.ownerDetail(seq).item.events[0]).toMatchObject({ actor: 'owner', kind: 'decision', batchId: 1 });
    expect(service.store().getBatch(APP, 1)!.source).toBe('local');
    const pending = await service.cli({ action: 'pending' }, { sessionId: 's' }) as any;
    expect(pending.decisions.map((d: any) => [d.batchId, d.seq, d.choice])).toEqual([[1, seq, 'A']]);
  });

  it('管家群里这一项的卡片写明是本机客户端做的决定', async () => {
    const seq = await addDecide();
    await service.ownerDecide({ seq, askKey: keyOf(seq), choice: 'B', requestId: 'req-card-001' });
    await service.cardsIdle();
    const text = JSON.stringify(service.cards!.render(seq)!.card);
    expect(text).toContain('本机客户端已选 **B 不合**');
    expect(text).not.toContain('网页上已选');
  });

  it('待验收的项可以只写说明', async () => {
    const seq = await add('验收新卡片', { state: 'accept' });
    const res = await service.ownerDecide({ seq, askKey: keyOf(seq), text: '验收通过', requestId: 'req-accept-1' });
    expect(res.batch.delivery).toBe('delivered');
    expect(delivered[0]!.prompt).toContain('验收通过');
  });

  it('管家改过问题或选项、事项已不在待拍板、选项不存在、什么都没写：拒绝且不写入、不投递', async () => {
    const seq = await addDecide();
    const askKey = keyOf(seq);
    await service.cli({ action: 'set', ref: String(seq), options: ['A=合', 'C=拆开'] }, { sessionId: 's' });
    expect(await errorCode(() => service.ownerDecide({ seq, askKey, choice: 'A', requestId: 'req-stale-01' }))).toBe('ask_changed');

    const fresh = keyOf(seq);
    expect(await errorCode(() => service.ownerDecide({ seq, askKey: fresh, choice: 'B', requestId: 'req-nochoice' }))).toBe('unknown_choice');
    expect(await errorCode(() => service.ownerDecide({ seq, askKey: fresh, text: '  ', requestId: 'req-empty-01' }))).toBe('nothing_to_submit');

    await service.cli({ action: 'set', ref: String(seq), fields: { state: 'active' } }, { sessionId: 's' });
    expect(await errorCode(() => service.ownerDecide({ seq, askKey: keyOf(seq), choice: 'A', requestId: 'req-active-1' }))).toBe('item_not_awaiting');

    expect(service.store().decisionsFor(APP, seq, false)).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it('只改了状态（待拍板 ⇄ 待验收、重新进入待拍板）也算改过：拿旧视图提交被拒', async () => {
    const seq = await addDecide();
    const decideKey = keyOf(seq);
    await service.cli({ action: 'set', ref: String(seq), fields: { state: 'accept' } }, { sessionId: 's' });
    expect(await errorCode(() => service.ownerDecide({ seq, askKey: decideKey, choice: 'B', requestId: 'req-flip-001' }))).toBe('ask_changed');
    const acceptKey = keyOf(seq);
    await service.cli({ action: 'set', ref: String(seq), fields: { state: 'decide' } }, { sessionId: 's' });
    expect(await errorCode(() => service.ownerDecide({ seq, askKey: acceptKey, text: '验收通过', requestId: 'req-flip-002' }))).toBe('ask_changed');
    expect(service.store().decisionsFor(APP, seq, false)).toEqual([]);
  });

  it('参数不对、管家没开或没选管家群时拒绝', async () => {
    const seq = await addDecide();
    const askKey = keyOf(seq);
    expect(await errorCode(() => service.ownerDecide({ seq, askKey, choice: 'A', requestId: 'short' }))).toBe('invalid_request_id');
    expect(await errorCode(() => service.ownerDecide({ seq, askKey: '', choice: 'A', requestId: 'req-noask-01' }))).toBe('ask_key_required');
    expect(await errorCode(() => service.ownerDecide({ seq: 999, askKey, choice: 'A', requestId: 'req-missing' }))).toBe('item_not_found');
    steward = { enabled: true };
    expect(await errorCode(() => service.ownerDecide({ seq, askKey, choice: 'A', requestId: 'req-nochat-1' }))).toBe('not_steward');
    expect(service.store().decisionsFor(APP, seq, false)).toEqual([]);
  });

  it('同一个 requestId 带同样的内容重试：不建第二批；上一次没送达时用同一个回合 id 重投；内容不同就拒绝', async () => {
    const seq = await addDecide();
    const askKey = keyOf(seq);
    deliverImpl = async () => { throw new Error('steward session busy'); };
    const first = await service.ownerDecide({ seq, askKey, choice: 'B', text: '先不合', requestId: 'req-retry-01' });
    expect(first.batch).toEqual({ id: 1, delivery: 'failed', error: 'steward session busy' });

    deliverImpl = async input => { delivered.push(input); return { sessionId: 'sess-steward' }; };
    const again = await service.ownerDecide({ seq, askKey, choice: 'B', text: '先不合', requestId: 'req-retry-01' });
    expect(again).toMatchObject({ duplicate: true, batch: { id: 1, delivery: 'delivered' } });
    expect(delivered.map(d => d.turnId)).toEqual([`board:${APP}:1`]);

    const third = await service.ownerDecide({ seq, askKey, choice: 'B', text: '先不合', requestId: 'req-retry-01' });
    expect(third).toMatchObject({ duplicate: true, batch: { id: 1, delivery: 'delivered' } });
    expect(delivered).toHaveLength(1);

    for (const changed of [{ choice: 'A', text: '先不合' }, { choice: 'B', text: '其实合吧' }]) {
      expect(await errorCode(() => service.ownerDecide({ seq, askKey, ...changed, requestId: 'req-retry-01' }))).toBe('request_id_reused');
    }
    const other = await addDecide('另一项');
    expect(await errorCode(() => service.ownerDecide({ seq: other, askKey: keyOf(other), choice: 'B', text: '先不合', requestId: 'req-retry-01' })))
      .toBe('request_id_reused');
    expect(service.store().decisionsFor(APP, seq, false)).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  it('重试时那一批正在本进程里投：不判死、不重投，投完只有一次', async () => {
    const seq = await addDecide();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    deliverImpl = async input => { await gate; delivered.push(input); return { sessionId: 'sess-steward' }; };
    const first = service.ownerDecide({ seq, askKey: keyOf(seq), choice: 'A', requestId: 'req-slow-001' });
    await new Promise(resolve => setImmediate(resolve));
    expect(service.store().getBatch(APP, 1)!.delivery).toBe('dispatched');

    const retry = await service.ownerDecide({ seq, askKey: keyOf(seq), choice: 'A', requestId: 'req-slow-001' });
    expect(retry).toMatchObject({ duplicate: true, batch: { id: 1, delivery: 'dispatched' } });
    release();
    expect((await first).batch.delivery).toBe('delivered');
    expect(delivered.map(d => d.turnId)).toEqual([`board:${APP}:1`]);
  });

  it('上一轮进程死在投递途中（dispatched 残留）：同一个 requestId 重试一次就收敛并重投', async () => {
    const seq = await addDecide();
    const askKey = keyOf(seq);
    deliverImpl = async () => { throw new Error('down'); };
    await service.ownerDecide({ seq, askKey, choice: 'A', requestId: 'req-crash-01' });
    service.store().markBatchDispatched(APP, 1, `board:${APP}:1`);
    service.close();
    service = makeService();
    deliverImpl = async input => { delivered.push(input); return { sessionId: 'sess-steward' }; };

    const retry = await service.ownerDecide({ seq, askKey, choice: 'A', requestId: 'req-crash-01' });
    expect(retry.batch).toEqual({ id: 1, delivery: 'delivered' });
    expect(delivered.map(d => d.turnId)).toEqual([`board:${APP}:1`]);
  });

  it('以后提交的为准：较早没送到的决定（卡片或本机）作废，重试作废的那条不再投', async () => {
    const seq = await addDecide();
    deliverImpl = async () => { throw new Error('down'); };
    const pick = service.cardClick({
      operatorOpenId: OWNER,
      value: { app: APP, seq: String(seq), action: DECISION_CARD_ACTION_PICK, key: 'A', ask: decisionAskKey(service.store().getItem(APP, seq)!) },
      messageId: sent[0]!.messageId,
    });
    await pick.deliver!();
    const local = await service.ownerDecide({ seq, askKey: keyOf(seq), choice: 'B', requestId: 'req-over-001' });
    expect(local.supersedes).toEqual([1]);
    expect(local.batch.delivery).toBe('failed');

    deliverImpl = async input => { delivered.push(input); return { sessionId: 'sess-steward' }; };
    const second = await service.ownerDecide({ seq, askKey: keyOf(seq), choice: 'A', text: '还是 A', requestId: 'req-over-002' });
    expect(second.supersedes).toEqual([2]);
    expect(service.store().decisionsFor(APP, seq, false).map(d => [d.batchId, !!d.handledAt, d.supersededBy])).toEqual([
      [1, true, 2], [2, true, 3], [3, false, undefined],
    ]);

    const stale = await service.ownerDecide({ seq, askKey: keyOf(seq), choice: 'B', requestId: 'req-over-001' });
    expect(stale).toMatchObject({ duplicate: true, decision: { handled: true, supersededBy: 3 }, batch: { id: 2, delivery: 'failed' } });
    expect(delivered.map(d => d.turnId)).toEqual([`board:${APP}:3`]);
    const pending = await service.cli({ action: 'pending' }, { sessionId: 's' }) as any;
    expect(pending.decisions.map((d: any) => [d.batchId, d.choice])).toEqual([[3, 'A']]);
  });

  it('已经送到管家的较早决定不作废：新决定提醒管家先如实标记那一条', async () => {
    const seq = await addDecide();
    await service.ownerDecide({ seq, askKey: keyOf(seq), choice: 'A', requestId: 'req-sent-001' });
    const later = await service.ownerDecide({ seq, askKey: keyOf(seq), choice: 'B', requestId: 'req-sent-002' });
    expect(later.supersedes).toEqual([1]);
    expect(service.store().decisionsFor(APP, seq, false).map(d => [d.batchId, !!d.handledAt, d.supersededBy])).toEqual([
      [1, false, 2], [2, false, undefined],
    ]);
    expect(delivered[1]!.prompt).toContain('覆盖：批次 #1 里对这一项的决定已送到你这里、还没标执行');
  });

  it('待验收的说明逐条都交给管家，不互相作废', async () => {
    const seq = await add('验收新卡片', { state: 'accept' });
    deliverImpl = async () => { throw new Error('down'); };
    await service.ownerDecide({ seq, askKey: keyOf(seq), text: '按钮颜色不对', requestId: 'req-acc-0001' });
    deliverImpl = async input => { delivered.push(input); return { sessionId: 'sess-steward' }; };
    const second = await service.ownerDecide({ seq, askKey: keyOf(seq), text: '另外字号小了', requestId: 'req-acc-0002' });
    expect(second.supersedes).toEqual([]);
    expect(service.store().decisionsFor(APP, seq, false).map(d => [d.batchId, !!d.handledAt, d.supersededBy])).toEqual([
      [1, false, undefined], [2, false, undefined],
    ]);
  });

  it('决定排队期间管家改了选项：交给管家时不附现在的选项原文，写明选项改过', async () => {
    const seq = await addDecide();
    deliverImpl = async () => { throw new Error('down'); };
    await service.ownerDecide({ seq, askKey: keyOf(seq), choice: 'A', requestId: 'req-queue-01' });
    await service.cli({ action: 'set', ref: String(seq), options: ['A=关掉不做', 'B=合'] }, { sessionId: 's' });
    deliverImpl = async input => { delivered.push(input); return { sessionId: 'sess-steward' }; };
    await service.redeliver(1);
    expect(delivered[0]!.prompt).not.toContain('关掉不做');
    expect(delivered[0]!.prompt).not.toContain('管家推荐');
    expect(delivered[0]!.prompt).toContain('提交后你改过问题或选项');
  });
});

describe('parseOwnerBoardStates', () => {
  it('默认待拍板 + 待验收；all 是全部状态；不认识的状态整个拒绝', () => {
    expect(parseOwnerBoardStates(undefined)).toEqual(['decide', 'accept']);
    expect(parseOwnerBoardStates('')).toEqual(['decide', 'accept']);
    expect(parseOwnerBoardStates('active, waiting,active')).toEqual(['active', 'waiting']);
    expect(parseOwnerBoardStates('all')).toEqual(['decide', 'accept', 'active', 'waiting', 'done', 'closed']);
    expect(parseOwnerBoardStates('decide,nope')).toBeNull();
  });
});
