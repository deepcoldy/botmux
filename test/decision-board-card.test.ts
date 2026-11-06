/**
 * 决策看板的飞书拍板卡片：发卡、原地更新、降级、只认 owner、点击走批次投递、和网页提交冲突。
 * 用真实的 DecisionBoardService + 临时库，卡片的发送 / 更新换成记录调用的假实现。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionBoardService, type DecisionBoardServiceDeps } from '../src/core/decision-board/service.js';
import {
  DECISION_CARD_ACTION_NOTE,
  DECISION_CARD_ACTION_PICK,
  DECISION_CARD_NOTE_FIELD,
  buildDecisionCard,
} from '../src/core/decision-board/card.js';
import { handleDecisionCardAction, setDecisionCardService } from '../src/core/decision-board/card-action.js';
import { DECISION_CARD_MAX_OPTIONS, normalizeStewardConfig, type StewardConfig } from '../src/core/decision-board/model.js';
import { isBotmuxCardAction } from '../src/core/card-action-namespace.js';
import { BoardError, DecisionBoardStore } from '../src/services/decision-board-store.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';

const APP = 'cli_steward';
const OWNER = 'ou_owner';

class GoneError extends Error {}

let dir: string;
let steward: StewardConfig | undefined;
let delivered: Array<Parameters<DecisionBoardServiceDeps['deliver']>[0]>;
let deliverImpl: DecisionBoardServiceDeps['deliver'];
let sent: Array<{ chatId: string; card: any; messageId: string; uuid: string }>;
let sendImpl: () => Promise<void>;
let updated: Array<{ messageId: string; card: any }>;
let updateImpl: (messageId: string) => Promise<void>;
let service: DecisionBoardService;
let owner: string | undefined;

function makeService(): DecisionBoardService {
  return new DecisionBoardService({
    dataDir: dir,
    larkAppId: () => APP,
    steward: () => steward,
    locale: () => 'zh',
    brand: () => 'feishu',
    dashboardOrigin: () => 'https://dash.example',
    ownerOpenId: () => owner,
    ownerName: async () => '主人',
    timeZone: () => 'UTC',
    batchAttachmentsDir: batchId => join(dir, 'attachments', `board-${batchId}`),
    banner: ({ batchId, count }) => `收到 ${count} 项（#${batchId}）`,
    deliver: input => deliverImpl(input),
    log: () => {},
    lookupChat: async chatId => ({ ok: true, chatId, appId: APP, name: '群' }),
    cards: {
      sendCard: async (chatId, card, uuid) => {
        await sendImpl();
        const messageId = `om_card_${sent.length + 1}`;
        sent.push({ chatId, card: JSON.parse(card), messageId, uuid });
        return messageId;
      },
      updateCard: async (messageId, card) => {
        await updateImpl(messageId);
        updated.push({ messageId, card: JSON.parse(card) });
      },
      isCardGone: error => error instanceof GoneError,
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-board-card-'));
  steward = { enabled: true, chatId: 'oc_steward' };
  delivered = [];
  deliverImpl = async input => { delivered.push(input); return { sessionId: 'sess-steward' }; };
  sent = [];
  updated = [];
  updateImpl = async () => {};
  sendImpl = async () => {};
  owner = OWNER;
  service = makeService();
});
afterEach(() => { setDecisionCardService(undefined); service.close(); rmSync(dir, { recursive: true, force: true }); });

/** 卡片里所有元素（递归展开 form / column_set）。 */
function elements(card: any): any[] {
  const out: any[] = [];
  const walk = (list: any[] | undefined) => {
    for (const el of list ?? []) {
      out.push(el);
      walk(el.elements);
      for (const col of el.columns ?? []) walk(col.elements);
    }
  };
  walk(card.body?.elements);
  return out;
}
const callbackButtons = (card: any) => elements(card).filter(e => e.tag === 'button' && e.behaviors?.[0]?.type === 'callback');
const pickButtons = (card: any) => callbackButtons(card).filter(b => b.behaviors[0].value.action === DECISION_CARD_ACTION_PICK);
const linkButtons = (card: any) => elements(card).filter(e => e.tag === 'button' && e.behaviors?.[0]?.type === 'open_url');
const cardText = (card: any) => elements(card).filter(e => e.tag === 'markdown').map(e => e.content).join('\n');

async function addDecide(options = ['A=合 → 风险小', 'B=不合 → 再等一轮'], extra: Record<string, unknown> = {}) {
  const res = await service.cli({
    action: 'add', title: 'PR #1 合不合', fields: { summary: 'CI 全绿，等你定', question: '合不合？', recommend: 'A', recommendReason: '改动小', ...extra },
    options, noChat: '用例里没有群',
  }, { sessionId: 'sess-1' }) as { item: { seq: number } };
  await service.cardsIdle();
  return res.item.seq;
}

/** 当前卡片（最后一次发出或更新的内容）。 */
function currentCard(): any {
  return updated.length ? updated[updated.length - 1]!.card : sent[sent.length - 1]!.card;
}

function click(card: any, opts: { operator?: string; key?: string; note?: string; action?: string; messageId?: string } = {}) {
  const btn = opts.action === DECISION_CARD_ACTION_NOTE
    ? callbackButtons(card).find(b => b.behaviors[0].value.action === DECISION_CARD_ACTION_NOTE)
    : pickButtons(card).find(b => b.behaviors[0].value.key === (opts.key ?? 'A'));
  return service.cardClick({
    operatorOpenId: opts.operator ?? OWNER,
    operatorUnionId: 'on_owner',
    value: btn.behaviors[0].value,
    formValue: opts.note !== undefined ? { [DECISION_CARD_NOTE_FIELD]: opts.note } : {},
    messageId: opts.messageId ?? service.store().getCard(APP, Number(btn.behaviors[0].value.seq))?.messageId,
  });
}

async function webSubmit(seq: number, choice: string, text: string, nonce: string) {
  const item = service.store().getItem(APP, seq)!;
  const draft = service.putDraft(seq, 'owner', { choice, text, baseRev: item.rev }).draft!;
  const res = await service.submit({ author: 'owner', submitter: 'local', nonce, items: [{ seq, draftUpdatedAt: draft.updatedAt }] });
  await service.cardsIdle();
  return res;
}

describe('发卡', () => {
  it('新建即待拍板：往管家群发一张卡，每个选项一个按钮、推荐项标出、带说明框和看板链接', async () => {
    const seq = await addDecide();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe('oc_steward');
    const card = sent[0]!.card;
    expect(card.header.title.content).toContain(`#${seq} PR #1 合不合`);
    expect(cardText(card)).toContain('CI 全绿，等你定');
    const picks = pickButtons(card);
    expect(picks.map(b => b.behaviors[0].value.key)).toEqual(['A', 'B']);
    expect(picks.find(b => b.behaviors[0].value.key === 'A')!.type).toBe('primary');
    expect(picks.find(b => b.behaviors[0].value.key === 'A')!.text.content).toContain('推荐');
    expect(picks.find(b => b.behaviors[0].value.key === 'B')!.type).toBe('default');
    expect(elements(card).some(e => e.tag === 'input' && e.name === DECISION_CARD_NOTE_FIELD)).toBe(true);
    expect(linkButtons(card)[0].behaviors[0].default_url).toBe(`https://dash.example/board/${APP}/${seq}`);
    // 回调都在 botmux 保留的动作前缀下，插件抢不走。
    for (const b of callbackButtons(card)) expect(isBotmuxCardAction(b.behaviors[0].value.action)).toBe(true);
  });

  it('从进行中改成待拍板时发卡；没进入待拍板的项、管家没开 / 没选群 / 关了卡片开关时都不发', async () => {
    const res = await service.cli({ action: 'add', title: '普通事项', noChat: 'x' }, { sessionId: 's' }) as any;
    await service.cardsIdle();
    expect(sent).toHaveLength(0);
    await service.cli({ action: 'set', ref: String(res.item.seq), fields: { state: 'decide', question: '要不要做？' }, options: ['A=做', 'B=不做'] }, { sessionId: 's' });
    await service.cardsIdle();
    expect(sent).toHaveLength(1);

    for (const cfg of [{ enabled: true } as StewardConfig, { enabled: true, chatId: 'oc_steward', decisionCards: false }]) {
      steward = cfg;
      sent = [];
      await addDecide();
      expect(sent).toHaveLength(0);
    }
  });

  it('管家 bot 认不出 owner 时不发卡（谁点都会被拒）；有了 owner 之后再进入待拍板照常发', async () => {
    owner = undefined;
    const seq = await addDecide();
    expect(sent).toHaveLength(0);
    owner = OWNER;
    await service.cli({ action: 'set', ref: String(seq), options: ['A=合', 'B=再等'] }, { sessionId: 's' });
    await service.cardsIdle();
    expect(sent).toHaveLength(1);
  });

  it('开关默认开，只在关掉时写 decisionCards:false；非布尔拒绝', () => {
    expect(normalizeStewardConfig({ enabled: true, chatId: 'oc_a', decisionCards: true })).toEqual({ ok: true, value: { enabled: true, chatId: 'oc_a' } });
    expect(normalizeStewardConfig({ enabled: true, chatId: 'oc_a', decisionCards: false }))
      .toEqual({ ok: true, value: { enabled: true, chatId: 'oc_a', decisionCards: false } });
    expect(normalizeStewardConfig({ enabled: false, decisionCards: false })).toEqual({ ok: true, value: { enabled: false, decisionCards: false } });
    expect(normalizeStewardConfig({ enabled: true, decisionCards: 'no' }).ok).toBe(false);
  });
});

describe('原地更新', () => {
  it('改选项只更新同一张卡，不重复发；只改进展时内容不变就不 PATCH', async () => {
    const seq = await addDecide();
    await service.cli({ action: 'set', ref: String(seq), options: ['A=合', 'B=不合', 'C=拆开再合'] }, { sessionId: 's' });
    await service.cardsIdle();
    expect(sent).toHaveLength(1);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.messageId).toBe(sent[0]!.messageId);
    expect(pickButtons(updated[0]!.card).map(b => b.behaviors[0].value.key)).toEqual(['A', 'B', 'C']);

    await service.cli({ action: 'set', ref: String(seq), fields: { progress: '又跑了一轮 CI' } }, { sessionId: 's' });
    await service.cardsIdle();
    expect(updated).toHaveLength(1);
  });

  it('daemon 重启后照样更新原来那张卡（消息 id 落库）', async () => {
    const seq = await addDecide();
    service.close();
    service = makeService();
    await service.cli({ action: 'set', ref: String(seq), options: ['A=合', 'B=不合', 'C=拆开'] }, { sessionId: 's' });
    await service.cardsIdle();
    expect(sent).toHaveLength(1);
    expect(updated.map(u => u.messageId)).toEqual([sent[0]!.messageId]);
  });

  it('连续两次 set 并发进来也只发一张卡', async () => {
    const res = await service.cli({ action: 'add', title: 'x', noChat: 'x' }, { sessionId: 's' }) as any;
    const ref = String(res.item.seq);
    await Promise.all([
      service.cli({ action: 'set', ref, fields: { state: 'decide', question: 'q' }, options: ['A=a', 'B=b'] }, { sessionId: 's' }),
      service.cli({ action: 'set', ref, options: ['A=a', 'B=b2'] }, { sessionId: 's' }),
    ]);
    await service.cardsIdle();
    expect(sent).toHaveLength(1);
  });

  it('卡已失效（撤回 / 过期）且仍待拍板时另发一张顶替，之后更新新卡', async () => {
    const seq = await addDecide();
    updateImpl = async messageId => { if (messageId === 'om_card_1') throw new GoneError('gone'); };
    await service.cli({ action: 'set', ref: String(seq), options: ['A=合', 'B=再等'] }, { sessionId: 's' });
    await service.cardsIdle();
    expect(sent.map(s => s.messageId)).toEqual(['om_card_1', 'om_card_2']);
    await service.cli({ action: 'set', ref: String(seq), options: ['A=合', 'B=再等等'] }, { sessionId: 's' });
    await service.cardsIdle();
    expect(updated.at(-1)!.messageId).toBe('om_card_2');
  });

  it('更新失败但不是失效：只记日志，不补发（免得重复卡），看板写入照常成功', async () => {
    const seq = await addDecide();
    updateImpl = async () => { throw new Error('rate limited'); };
    const res = await service.cli({ action: 'set', ref: String(seq), options: ['A=合', 'B=再等'] }, { sessionId: 's' }) as any;
    await service.cardsIdle();
    expect(res.item.options).toHaveLength(2);
    expect(sent).toHaveLength(1);
  });
});

describe('降级', () => {
  it('事项关闭：卡片原地改成只有现状和链接，没有按钮和说明框', async () => {
    const seq = await addDecide();
    await service.cli({ action: 'set', ref: String(seq), fields: { state: 'closed' } }, { sessionId: 's' });
    await service.cardsIdle();
    const card = currentCard();
    expect(updated).toHaveLength(1);
    expect(callbackButtons(card)).toHaveLength(0);
    expect(elements(card).some(e => e.tag === 'input')).toBe(false);
    expect(linkButtons(card)).toHaveLength(1);
    expect(card.header.template).toBe('grey');
  });

  it('选项超过卡片上限：只给链接', async () => {
    const options = Array.from({ length: DECISION_CARD_MAX_OPTIONS + 1 }, (_, i) => `${String.fromCharCode(65 + i)}=选项${i}`);
    await addDecide(options, { recommend: 'A' });
    const card = sent[0]!.card;
    expect(callbackButtons(card)).toHaveLength(0);
    expect(linkButtons(card)).toHaveLength(1);
    expect(cardText(card)).toContain(`${DECISION_CARD_MAX_OPTIONS + 1} 个选项`);
  });

  it('选项刚好在上限内：照常每个选项一个按钮', async () => {
    const options = Array.from({ length: DECISION_CARD_MAX_OPTIONS }, (_, i) => `${String.fromCharCode(65 + i)}=选项${i}`);
    await addDecide(options);
    expect(pickButtons(sent[0]!.card)).toHaveLength(DECISION_CARD_MAX_OPTIONS);
  });

  it('拿不到 Dashboard 地址时不放链接按钮，改写成文字指引', () => {
    const card = buildDecisionCard({
      appId: APP, locale: 'zh', links: {},
      item: { seq: 3, title: 't', state: 'closed', options: [], rev: 1, createdAt: 1, updatedAt: 1, stateAt: 1 },
    });
    expect(linkButtons(card)).toHaveLength(0);
    expect(cardText(card)).toContain('#3');
  });
});

describe('点击', () => {
  it('非 owner 点：提示无权限，不建批次、不投递、卡片不变', async () => {
    const seq = await addDecide();
    const res = click(sent[0]!.card, { operator: 'ou_someone' });
    expect(res.toast).toMatchObject({ type: 'error' });
    expect(res.toast!.content).toContain('owner');
    expect(res.card).toBeUndefined();
    expect(res.deliver).toBeUndefined();
    expect(service.store().listBatches(APP)).toHaveLength(0);
    expect(service.store().latestDecision(APP, seq)).toBeUndefined();
    expect(delivered).toHaveLength(0);
  });

  it('owner 点选项：建批次、和网页同一条投递路径送达管家，卡片显示「已选 X，已交给管家」', async () => {
    const seq = await addDecide();
    const res = click(sent[0]!.card, { key: 'A', note: '合完记得发版说明' });
    expect(res.toast).toMatchObject({ type: 'success' });
    expect(cardText(res.card)).toContain('已选 **A 合**');
    expect(cardText(res.card)).toContain('正在交给管家');
    expect(delivered).toHaveLength(0); // 投递在回调应答之后
    await res.deliver!();
    await service.cardsIdle();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.chatId).toBe('oc_steward');
    expect(delivered[0]!.turnId).toBe(`board:${APP}:1`);
    expect(delivered[0]!.prompt).toContain(`#${seq} PR #1 合不合（待拍板）\n选：A 合（管家推荐）\n来源：管家群的拍板卡片`);
    expect(delivered[0]!.prompt).toContain('说明：\n合完记得发版说明');
    expect(delivered[0]!.ownerOpenId).toBe(OWNER);
    const batch = service.store().getBatch(APP, 1)!;
    expect(batch).toMatchObject({ delivery: 'delivered', source: 'card', author: 'u:on_owner' });
    const pending = await service.cli({ action: 'pending' }, { sessionId: 's' }) as any;
    expect(pending.decisions).toMatchObject([{ batchId: 1, seq, choice: 'A', text: '合完记得发版说明' }]);
    expect(cardText(currentCard())).toContain('已交给管家（批次 #1）');
    // 网页上那份草稿不被卡片动过；时间线上记了来源。
    const detail = service.detail(seq, 'owner');
    expect(detail.events.some((e: any) => e.kind === 'decision' && e.text.includes('飞书卡片'))).toBe(true);
  });

  it('只交说明：不选选项也能提交；说明为空时提示先写', async () => {
    await addDecide();
    expect(click(sent[0]!.card, { action: DECISION_CARD_ACTION_NOTE, note: '  ' }).toast!.content).toContain('说明');
    expect(service.store().listBatches(APP)).toHaveLength(0);
    const res = click(sent[0]!.card, { action: DECISION_CARD_ACTION_NOTE, note: '先别合，等我看一眼' });
    await res.deliver!();
    expect(delivered[0]!.prompt).toContain('选：未选');
    expect(delivered[0]!.prompt).toContain('先别合，等我看一眼');
  });

  it('同一个选择连点 / 重试：不建第二个批次', async () => {
    await addDecide();
    const first = click(sent[0]!.card, { key: 'B' });
    await first.deliver!();
    const again = click(sent[0]!.card, { key: 'B' });
    expect(again.toast).toMatchObject({ type: 'info' });
    expect(again.deliver).toBeUndefined();
    expect(service.store().listBatches(APP)).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  it('投递失败后再点同一个选择：重投那一批（同一个回合 id），卡片显示失败原因再转为已交给管家', async () => {
    await addDecide();
    deliverImpl = async () => { throw new Error('steward session busy'); };
    const first = click(sent[0]!.card, { key: 'A' });
    await first.deliver!();
    await service.cardsIdle();
    expect(cardText(currentCard())).toContain('交给管家失败（批次 #1）');
    deliverImpl = async input => { delivered.push(input); return { sessionId: 's' }; };
    const retry = click(sent[0]!.card, { key: 'A' });
    await retry.deliver!();
    await service.cardsIdle();
    expect(delivered.map(d => d.turnId)).toEqual([`board:${APP}:1`]);
    expect(cardText(currentCard())).toContain('已交给管家（批次 #1）');
  });

  it('旧卡片（选项已改）上的点击不写入，换上最新卡片', async () => {
    const seq = await addDecide();
    const oldCard = sent[0]!.card;
    await service.cli({ action: 'set', ref: String(seq), options: ['A=合', 'B=拆开再合'] }, { sessionId: 's' });
    await service.cardsIdle();
    const res = click(oldCard, { key: 'B' });
    expect(res.toast!.content).toContain('刷新');
    expect(pickButtons(res.card).map(b => b.text.content)).toEqual(expect.arrayContaining([expect.stringContaining('拆开再合')]));
    expect(service.store().listBatches(APP)).toHaveLength(0);
  });

  it('事项已不在待拍板：不写入，卡片换成降级版', async () => {
    const seq = await addDecide();
    const card = sent[0]!.card;
    service.store().updateItem(APP, seq, { state: 'active' });
    const res = click(card, { key: 'A' });
    expect(res.toast!.content).toContain('不在待拍板');
    expect(callbackButtons(res.card)).toHaveLength(0);
    expect(service.store().listBatches(APP)).toHaveLength(0);
  });

  it('回调入口：按飞书事件里的 operator 鉴权，换卡用 raw 形态，投递放在 afterAck', async () => {
    await addDecide();
    setDecisionCardService(service);
    const btn = pickButtons(sent[0]!.card)[0];
    const denied = await handleDecisionCardAction({
      operator: { open_id: 'ou_someone' }, action: { value: { ...btn.behaviors[0].value } },
    } as any, APP);
    expect(denied.toast.type).toBe('error');
    const out = await handleDecisionCardAction({
      operator: { open_id: OWNER, union_id: 'on_owner' },
      action: { value: btn.behaviors[0].value, form_value: { [DECISION_CARD_NOTE_FIELD]: '好' } },
      context: { open_message_id: sent[0]!.messageId },
    } as any, APP);
    expect(out.card.type).toBe('raw');
    expect(typeof out.afterAck).toBe('function');
    await out.afterAck();
    expect(delivered).toHaveLength(1);
    // 别的 app 的卡片（value.app 不符）不处理。
    const foreign = await handleDecisionCardAction({ operator: { open_id: OWNER }, action: { value: { ...btn.behaviors[0].value, app: 'cli_other' } } } as any, APP);
    expect(foreign.toast.type).toBe('warning');
  });
});

describe('和网页提交冲突：以后提交的为准', () => {
  it('卡片那批还没送到时网页又提交：卡片那条作废（不再待执行），网页那批写「作废」，迟到的卡片批次写「不用执行」', async () => {
    const seq = await addDecide();
    deliverImpl = async () => { throw new Error('down'); };
    const res = click(sent[0]!.card, { key: 'A' });
    await res.deliver!();
    deliverImpl = async input => { delivered.push(input); return { sessionId: 's' }; };
    await webSubmit(seq, 'B', '还是再等一轮', 'web-1');

    expect(delivered.map(d => d.turnId)).toEqual([`board:${APP}:2`]);
    expect(delivered[0]!.prompt).toContain('覆盖：批次 #1 里对这一项的决定作废，以本次为准');
    const pending = await service.cli({ action: 'pending' }, { sessionId: 's' }) as any;
    expect(pending.decisions.map((d: any) => [d.batchId, d.choice])).toEqual([[2, 'B']]);
    const text = cardText(currentCard());
    expect(text).toContain('网页上已选 **B 不合**');
    expect(text).toContain('覆盖了卡片批次 #1 的决定');
    expect(service.detail(seq, 'owner').events.some((e: any) => e.text.includes('批次 #2 覆盖了批次 #1'))).toBe(true);

    await service.redeliver(1);
    const late = delivered.find(d => d.turnId === `board:${APP}:1`)!;
    expect(late.prompt).toContain('已被覆盖：这一项后来在批次 #2 改了决定');
  });

  it('网页那批已送到管家（可能在执行）时卡片改选：旧的仍待执行，--handled 落在实际执行的那批上，新的不丢', async () => {
    const seq = await addDecide();
    await webSubmit(seq, 'A', '', 'web-1');
    const res = click(sent[0]!.card, { key: 'B', note: '改主意了' });
    expect(cardText(res.card)).toContain('覆盖了网页批次 #1 的决定');
    await res.deliver!();
    expect(delivered[1]!.prompt).toContain('覆盖：批次 #1 里对这一项的决定已送到你这里、还没标执行');
    let pending = await service.cli({ action: 'pending' }, { sessionId: 's' }) as any;
    expect(pending.decisions.map((d: any) => d.batchId)).toEqual([1, 2]);

    const h = await service.cli({ action: 'history', ref: String(seq), text: '按 A 合了', handled: true }, { sessionId: 's' }) as any;
    expect(h.handledDecisions).toBe(1);
    expect(service.store().decisionsFor(APP, seq, false).map(d => [d.batchId, !!d.handledAt, d.supersededBy])).toEqual([
      [1, true, 2], [2, false, undefined],
    ]);
    pending = await service.cli({ action: 'pending' }, { sessionId: 's' }) as any;
    expect(pending.decisions.map((d: any) => [d.batchId, d.choice])).toEqual([[2, 'B']]);
    await service.cardsIdle();
    expect(cardText(currentCard())).toContain('已选 **B 不合**，已交给管家（批次 #2）');
    expect(cardText(currentCard())).not.toContain('管家已处理');

    await service.cli({ action: 'history', ref: String(seq), text: '按 B 处理', handled: true }, { sessionId: 's' });
    await service.cardsIdle();
    expect(cardText(currentCard())).toContain('管家已处理（批次 #2）');
  });

  it('网页上那份草稿写在选项改动之前（选的选项已不在）：照常送达，但不覆盖卡片上的决定', async () => {
    const seq = await addDecide();
    const item = service.store().getItem(APP, seq)!;
    const draft = service.putDraft(seq, 'owner', { choice: 'B', text: '', baseRev: item.rev }).draft!;
    await service.cli({ action: 'set', ref: String(seq), options: ['A=合', 'C=拆开'] }, { sessionId: 's' });
    await service.cardsIdle();
    deliverImpl = async () => { throw new Error('down'); };
    await click(currentCard(), { key: 'A' }).deliver!();
    deliverImpl = async input => { delivered.push(input); return { sessionId: 's' }; };
    await service.submit({ author: 'owner', submitter: 'local', nonce: 'web-old', items: [{ seq, draftUpdatedAt: draft.updatedAt }] });
    expect(service.store().decisionsFor(APP, seq, false).map(d => [d.batchId, d.supersededBy])).toEqual([[1, undefined], [2, undefined]]);
  });

  it('网页上连续两次提交（不涉及卡片）照旧逐批执行，不互相覆盖', async () => {
    const seq = await addDecide();
    await webSubmit(seq, 'A', '', 'web-1');
    await webSubmit(seq, 'B', '', 'web-2');
    const pending = await service.cli({ action: 'pending' }, { sessionId: 's' }) as any;
    expect(pending.decisions.map((d: any) => d.batchId)).toEqual([1, 2]);
    expect(delivered[1]!.prompt).not.toContain('覆盖');
  });

  it('网页那批还在投递时卡片又提交：按批次编号先后送进管家会话，后一批写明覆盖关系', async () => {
    const seq = await addDecide();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    deliverImpl = async input => { if (input.turnId.endsWith(':1')) await gate; delivered.push(input); return { sessionId: 's' }; };
    const item = service.store().getItem(APP, seq)!;
    const draft = service.putDraft(seq, 'owner', { choice: 'A', text: '', baseRev: item.rev }).draft!;
    const web = service.submit({ author: 'owner', submitter: 'local', nonce: 'web-1', items: [{ seq, draftUpdatedAt: draft.updatedAt }] });
    await new Promise(r => setTimeout(r, 0));
    const res = click(sent[0]!.card, { key: 'B' });
    const card = res.deliver!();
    await new Promise(r => setTimeout(r, 0));
    expect(delivered).toHaveLength(0);
    release();
    await Promise.all([web, card]);
    expect(delivered.map(d => d.turnId)).toEqual([`board:${APP}:1`, `board:${APP}:2`]);
    expect(delivered[1]!.prompt).toContain('已送到你这里');
  });
});

describe('点击：选项改过之后', () => {
  it('同一个选项键换了意思：卡片不再把旧决定写成新选项原文，再点同一个键是新决定', async () => {
    const seq = await addDecide();
    await click(sent[0]!.card, { key: 'A' }).deliver!();
    await service.cli({ action: 'set', ref: String(seq), options: ['A=拆成两个 PR 再合', 'B=不合'] }, { sessionId: 's' });
    await service.cardsIdle();
    const text = cardText(currentCard());
    expect(text).toContain('已选 **A**（之后选项改过）');
    expect(text).not.toContain('已选 **A 拆成两个 PR');
    const again = click(currentCard(), { key: 'A' });
    expect(again.toast!.type).toBe('success');
    await again.deliver!();
    expect(service.store().listBatches(APP)).toHaveLength(2);
  });

  it('旧卡片上与待执行决定相同的选择：按过期处理，不当成重复', async () => {
    const seq = await addDecide();
    const oldCard = sent[0]!.card;
    expect(click(oldCard, { key: 'A' }).toast!.type).toBe('success');
    await service.cli({ action: 'set', ref: String(seq), options: ['A=合但先拆 PR', 'B=不合'] }, { sessionId: 's' });
    await service.cardsIdle();
    const again = click(oldCard, { key: 'A' });
    expect(again.toast!.content).toContain('选项刚改过');
    expect(again.deliver).toBeUndefined();
  });

  it('submitCard：写锁里的 verify 抛错时整笔回滚，不建批次、不写决定', async () => {
    const seq = await addDecide();
    const store = service.store();
    expect(() => store.submitCard(APP, { seq, choice: 'A', text: '', submitter: 'owner', nonce: 'card:probe',
      verify: () => { throw new BoardError('card_stale'); } })).toThrow(/card_stale/);
    expect(store.listBatches(APP)).toHaveLength(0);
    expect(store.latestDecision(APP, seq)).toBeUndefined();
  });
});

describe('半途失败与恢复', () => {
  it('发卡失败：留下待发记录，之后任意一次同步（只改进展）补发；补发沿用同一个飞书去重键', async () => {
    const attempts: string[] = [];
    let fail = true;
    service.close();
    const base = makeService();
    const deps = (base as any).deps;
    base.close();
    service = new DecisionBoardService({ ...deps, cards: { ...deps.cards, sendCard: async (chatId: string, card: string, uuid: string) => {
      attempts.push(uuid);
      if (fail) throw new Error('timeout');
      return deps.cards.sendCard(chatId, card, uuid);
    } } });
    const seq = await addDecide();
    expect(sent).toHaveLength(0);
    expect(service.store().getCard(APP, seq)?.messageId).toBe('');
    fail = false;
    await service.cli({ action: 'set', ref: String(seq), fields: { progress: '又跑了一轮' } }, { sessionId: 's' });
    await service.cardsIdle();
    expect(sent).toHaveLength(1);
    expect(service.store().getCard(APP, seq)?.messageId).toBe(sent[0]!.messageId);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    service.cards!.stop();
  });

  it('启动对账时 owner 还没解析出来：待发占位留着，owner 回来后的对账照常补发', async () => {
    sendImpl = async () => { throw new Error('timeout'); };
    const seq = await addDecide();
    service.cards!.stop();
    sendImpl = async () => {};
    owner = undefined;
    await service.reconcileCards();
    expect(sent).toHaveLength(0);
    expect(service.store().getCard(APP, seq)?.messageId).toBe('');
    owner = OWNER;
    await service.reconcileCards();
    expect(sent).toHaveLength(1);
  });

  it('启动对账：补发上次没发出去的卡；已经发出去的不再发', async () => {
    sendImpl = async () => { throw new Error('timeout'); };
    await addDecide();
    service.cards!.stop();
    sendImpl = async () => {};
    service.close();
    service = makeService();
    await service.reconcileCards();
    await service.reconcileCards();
    expect(sent).toHaveLength(1);
  });

  it('daemon 死在投递途中：重启补投把批次收敛成失败时，卡片跟着显示失败', async () => {
    await addDecide();
    deliverImpl = () => new Promise(() => {});
    const res = click(sent[0]!.card, { key: 'A' });
    void res.deliver!();
    await new Promise(r => setTimeout(r, 0));
    expect(service.store().getBatch(APP, 1)!.delivery).toBe('dispatched');
    service.close();
    service = makeService();
    await service.redeliverUndelivered();
    await service.cardsIdle();
    expect(service.store().getBatch(APP, 1)!.delivery).toBe('failed');
    expect(cardText(currentCard())).toContain('交给管家失败（批次 #1）');
  });

  it('上一轮死在投递途中、补投前就再点同一个选择：收敛后按同一个回合 id 重投', async () => {
    await addDecide();
    deliverImpl = () => new Promise(() => {});
    void click(sent[0]!.card, { key: 'A' }).deliver!();
    await new Promise(r => setTimeout(r, 0));
    service.close();
    deliverImpl = async input => { delivered.push(input); return { sessionId: 's' }; };
    service = makeService();
    const again = click(sent[0]!.card, { key: 'A' });
    expect(again.deliver).toBeDefined();
    await again.deliver!();
    expect(delivered.map(d => d.turnId)).toEqual([`board:${APP}:1`]);
    expect(service.store().getBatch(APP, 1)!.delivery).toBe('delivered');
  });

  it('更新失败（不是失效）：按退避重试，成功后卡片对上', async () => {
    service.close();
    service = new DecisionBoardService({ ...(service as any).deps, cards: { ...(service as any).deps.cards } });
    (service.cards as any).deps.retryDelays = [5, 5];
    const seq = await addDecide();
    let failures = 1;
    updateImpl = async () => { if (failures-- > 0) throw new Error('rate limited'); };
    await service.cli({ action: 'set', ref: String(seq), options: ['A=合', 'B=再等'] }, { sessionId: 's' });
    await service.cardsIdle();
    expect(updated).toHaveLength(0);
    await new Promise(r => setTimeout(r, 30));
    await service.cardsIdle();
    expect(updated).toHaveLength(1);
    expect(pickButtons(updated[0]!.card).map(b => b.text.content).join()).toContain('再等');
    service.cards!.stop();
  });

  it('回调里出了意外错误：给 owner 一个看得见的失败提示，而不是没反应', async () => {
    await addDecide();
    setDecisionCardService(service);
    const btn = pickButtons(sent[0]!.card)[0];
    const store = service.store();
    const orig = store.submitCard.bind(store);
    store.submitCard = () => { throw new Error('database is locked'); };
    const out = await handleDecisionCardAction({ operator: { open_id: OWNER }, action: { value: btn.behaviors[0].value },
      context: { open_message_id: sent[0]!.messageId } } as any, APP);
    store.submitCard = orig;
    expect(out.toast.type).toBe('error');
  });
});

describe('开关与管家群变化', () => {
  it('关掉开关后：已发的卡收成只有链接，点了不写入；打开后下次变化恢复成能点的卡', async () => {
    const seq = await addDecide();
    steward = { enabled: true, chatId: 'oc_steward', decisionCards: false };
    await service.cli({ action: 'set', ref: String(seq), fields: { state: 'closed' } }, { sessionId: 's' });
    await service.cardsIdle();
    expect(callbackButtons(currentCard())).toHaveLength(0);
    const res = click(sent[0]!.card, { key: 'A' });
    expect(res.toast!.content).toContain('没开');
    expect(callbackButtons(res.card)).toHaveLength(0);
    expect(service.store().listBatches(APP)).toHaveLength(0);
    steward = { enabled: true, chatId: 'oc_steward' };
    await service.cli({ action: 'set', ref: String(seq), fields: { state: 'decide' } }, { sessionId: 's' });
    await service.cardsIdle();
    expect(pickButtons(currentCard())).toHaveLength(2);
    expect(sent).toHaveLength(1);
  });

  it('关着开关进入待拍板，打开后只改进展不发卡，改选项才发', async () => {
    steward = { enabled: true, chatId: 'oc_steward', decisionCards: false };
    const seq = await addDecide();
    expect(sent).toHaveLength(0);
    steward = { enabled: true, chatId: 'oc_steward' };
    await service.cli({ action: 'set', ref: String(seq), fields: { progress: '又跑了一轮' } }, { sessionId: 's' });
    await service.cardsIdle();
    expect(sent).toHaveLength(0);
    await service.cli({ action: 'set', ref: String(seq), options: ['A=合', 'B=不合', 'C=拆'] }, { sessionId: 's' });
    await service.cardsIdle();
    expect(sent).toHaveLength(1);
  });

  it('管家群换了：重新待拍板时在新群发卡，旧群那张收成只有链接；点旧卡不写入、也不变回能点的卡', async () => {
    const seq = await addDecide();
    await service.cli({ action: 'set', ref: String(seq), fields: { state: 'active' } }, { sessionId: 's' });
    await service.cardsIdle();
    steward = { enabled: true, chatId: 'oc_new' };
    await service.cli({ action: 'set', ref: String(seq), fields: { state: 'decide' } }, { sessionId: 's' });
    await service.cardsIdle();
    expect(sent.map(x => x.chatId)).toEqual(['oc_steward', 'oc_new']);
    const old = updated.filter(u => u.messageId === 'om_card_1').at(-1)!.card;
    expect(cardText(old)).toContain('管家群换了');
    expect(callbackButtons(old)).toHaveLength(0);
    const res = click(sent[1]!.card, { key: 'A', messageId: 'om_card_1' });
    expect(res.toast!.content).toContain('过期');
    expect(callbackButtons(res.card)).toHaveLength(0);
    expect(service.store().listBatches(APP)).toHaveLength(0);
  });
});

describe('存储迁移', () => {
  it('没有卡片列的旧库：打开时补列，旧数据照常读写', () => {
    const store = DecisionBoardStore.open(dir);
    store.addItem(APP, { title: '旧事项', question: 'q', options: [{ key: 'A', label: 'a' }] });
    store.close();
    const db = openDatabaseSyncOrThrow(join(dir, 'decision-board.sqlite'));
    db.exec('ALTER TABLE board_batches DROP COLUMN source; ALTER TABLE board_decisions DROP COLUMN superseded_by; DROP TABLE board_cards;');
    db.close();
    const reopened = DecisionBoardStore.open(dir);
    const draft = reopened.putDraft(APP, 1, 'owner', { choice: 'A', baseRev: 1 })!;
    const res = reopened.submit(APP, { author: 'owner', nonce: 'n', items: [{ seq: 1, draftUpdatedAt: draft.updatedAt }] });
    expect(res.batch.source).toBeUndefined();
    expect(reopened.pendingDecisions(APP)).toHaveLength(1);
    reopened.putCard(APP, { seq: 1, chatId: 'oc_x', messageId: 'om_1', hash: 'h' });
    expect(reopened.getCard(APP, 1)?.messageId).toBe('om_1');
    reopened.close();
  });
});
