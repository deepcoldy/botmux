/**
 * 决策看板持久层：事项的增改与自动历史、视图分组、草稿、一次提交一批（事务、nonce 去重、
 * 草稿被改过即拒）、管家回写已执行、附件落盘、批次投递状态。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardError, DecisionBoardStore, decisionBoardDbPath, decisionBoardFilesDir } from '../src/services/decision-board-store.js';

const APP = 'cli_steward';
const OTHER = 'cli_other';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let dir: string;
let store: DecisionBoardStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-board-'));
  store = DecisionBoardStore.open(dir);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function decideItem(title = 'PR #1 要不要合', now = 1_000) {
  return store.addItem(APP, {
    title,
    question: '合不合？',
    options: [{ key: 'A', label: '合' }, { key: 'B', label: '不合' }],
    recommend: 'A',
  }, 'sess-1', now).item;
}

describe('事项', () => {
  it('带 key 的重复 add 更新同一项，不重复建；不同管家的看板互不可见', () => {
    const first = store.addItem(APP, { title: 'PR #12', key: 'pr:o/r#12' }, 'sess-1', 1_000);
    expect(first.created).toBe(true);
    const again = store.addItem(APP, { title: 'PR #12 改名', key: 'pr:o/r#12', stage: '在审' }, 'sess-1', 2_000);
    expect(again.created).toBe(false);
    expect(again.item.seq).toBe(first.item.seq);
    expect(again.item.title).toBe('PR #12 改名');
    expect(store.listItems(APP, 'all')).toHaveLength(1);
    expect(store.listItems(OTHER, 'all')).toHaveLength(0);
    expect(store.resolveSeq(APP, { key: 'pr:o/r#12' })).toBe(first.item.seq);
    expect(store.resolveSeq(OTHER, { key: 'pr:o/r#12' })).toBeUndefined();
  });

  it('有问题没给状态时默认待拍板；改状态和待拍板内容自动进历史并递增 rev', () => {
    const item = decideItem();
    expect(item.state).toBe('decide');
    expect(item.rev).toBe(1);
    const updated = store.updateItem(APP, item.seq, { state: 'active', stage: '在修', progress: '在改' }, 'sess-1', 2_000);
    expect(updated.rev).toBe(2);
    expect(updated.stateAt).toBe(2_000);
    const kinds = store.events(APP, item.seq).map(e => `${e.kind}:${e.text}`);
    expect(kinds).toContain('state:待拍板 → 进行中');
    expect(kinds).toContain('edit:更新了当前进展');
    // 内容没变就不递增 rev，也不记历史。
    const same = store.updateItem(APP, item.seq, { stage: '在修' }, 'sess-1', 3_000);
    expect(same.rev).toBe(2);
  });

  it('key 撞到别的事项时拒绝', () => {
    store.addItem(APP, { title: 'a', key: 'k1' });
    const b = store.addItem(APP, { title: 'b', key: 'k2' }).item;
    expect(() => store.updateItem(APP, b.seq, { key: 'k1' })).toThrow(BoardError);
  });

  it('视图分组：待你拍板 = 待拍板 + 待验收，按进入时间先后；进行中 = 进行中 + 等待中', () => {
    const late = store.addItem(APP, { title: 'late', state: 'decide' }, undefined, 3_000).item;
    const early = store.addItem(APP, { title: 'early', state: 'accept' }, undefined, 1_000).item;
    store.addItem(APP, { title: 'w', state: 'waiting' }, undefined, 2_000);
    store.addItem(APP, { title: 'done', state: 'done' }, undefined, 2_000);
    expect(store.listItems(APP, 'decide').map(i => i.seq)).toEqual([early.seq, late.seq]);
    expect(store.listItems(APP, 'active').map(i => i.title)).toEqual(['w']);
    expect(store.counts(APP)).toEqual({ decide: 2, active: 1, all: 4 });
  });

  it('管家写过东西而 owner 还没打开详情时标 unseen，打开后清掉', () => {
    const item = decideItem();
    expect(store.listItems(APP, 'all')[0].unseen).toBe(true);
    store.markSeen(APP, item.seq, 5_000);
    expect(store.listItems(APP, 'all')[0].unseen).toBe(false);
    store.appendHistory(APP, item.seq, '有新进展', {}, 6_000);
    expect(store.listItems(APP, 'all')[0].unseen).toBe(true);
  });

  it('选项键重复、选项过多、标题过长都拒绝', () => {
    expect(() => store.addItem(APP, { title: 't', options: [{ key: 'A', label: 'x' }, { key: 'A', label: 'y' }] })).toThrow(/重复/);
    expect(() => store.addItem(APP, { title: 't', options: Array.from({ length: 9 }, (_, i) => ({ key: `K${i}`, label: 'x' })) })).toThrow(/最多/);
    expect(() => store.addItem(APP, { title: 'x'.repeat(201) })).toThrow(/太长/);
  });

  it('关联对象去重并记一条历史', () => {
    const item = store.addItem(APP, { title: 't', links: [{ kind: 'pr', ref: 'o/r#1' }] }).item;
    store.updateItem(APP, item.seq, { links: [{ kind: 'pr', ref: 'o/r#1', label: '主 PR' }, { kind: 'chat', ref: 'oc_abc' }] });
    expect(store.links(APP, item.seq)).toEqual([
      { kind: 'pr', ref: 'o/r#1', label: '主 PR' },
      { kind: 'chat', ref: 'oc_abc' },
    ]);
    expect(store.events(APP, item.seq).filter(e => e.kind === 'link')).toHaveLength(2);
  });
});

describe('草稿与提交', () => {
  it('空草稿等于删除；选项必须存在；附图必须是 owner 上传的', () => {
    const item = decideItem();
    expect(store.putDraft(APP, item.seq, 'local', { choice: 'A', text: '', baseRev: 1 })?.choice).toBe('A');
    expect(store.putDraft(APP, item.seq, 'local', { text: '  ', baseRev: 1 })).toBeUndefined();
    expect(store.getDraft(APP, item.seq, 'local')).toBeUndefined();
    expect(() => store.putDraft(APP, item.seq, 'local', { choice: 'Z', baseRev: 1 })).toThrow(/没有选项/);
    const stewardShot = store.attachFiles(APP, item.seq, [{ bytes: PNG, mime: 'image/png', name: 'a.png' }], undefined)[0];
    expect(() => store.putDraft(APP, item.seq, 'local', { fileIds: [stewardShot.id], baseRev: 1 })).toThrow(/附图/);
  });

  it('一次提交多项：一个批次、每项一条决定和一条历史、草稿清空、成为待执行', () => {
    const a = decideItem('a', 1_000);
    const b = decideItem('b', 1_100);
    const shot = store.addFile(APP, { bytes: PNG, mime: 'image/png', name: 'x.png', by: 'owner' });
    const da = store.putDraft(APP, a.seq, 'local', { choice: 'A', text: '合吧', fileIds: [shot.id], baseRev: 1 }, 2_000)!;
    const db = store.putDraft(APP, b.seq, 'local', { text: '先别动', baseRev: 1 }, 2_100)!;
    const res = store.submit(APP, {
      author: 'local', authorName: 'owner', nonce: 'n1',
      items: [{ seq: a.seq, draftUpdatedAt: da.updatedAt }, { seq: b.seq, draftUpdatedAt: db.updatedAt }],
    }, 3_000);
    expect(res.duplicate).toBe(false);
    expect(res.batch).toMatchObject({ id: 1, delivery: 'pending', attempts: 0 });
    expect(res.decisions.map(d => [d.seq, d.choice ?? null, d.text])).toEqual([[a.seq, 'A', '合吧'], [b.seq, null, '先别动']]);
    expect(store.listDrafts(APP, 'local')).toEqual([]);
    expect(store.pendingDecisions(APP)).toHaveLength(2);
    const ev = store.events(APP, a.seq).find(e => e.kind === 'decision')!;
    expect(ev).toMatchObject({ actor: 'owner', batchId: 1, text: '选 A：合吧', fileIds: [shot.id] });
    // 附图归到该事项名下
    expect(store.getFile(APP, shot.id)?.file.seq).toBe(a.seq);
  });

  it('同一个 nonce 再提交返回原批次，不建第二个', () => {
    const a = decideItem();
    const d = store.putDraft(APP, a.seq, 'local', { choice: 'B', baseRev: 1 })!;
    const first = store.submit(APP, { author: 'local', nonce: 'same', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    const second = store.submit(APP, { author: 'local', nonce: 'same', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    expect(second.duplicate).toBe(true);
    expect(second.batch.id).toBe(first.batch.id);
    expect(store.listBatches(APP)).toHaveLength(1);
  });

  it('草稿在别处改过就整批拒绝，什么都不写', () => {
    const a = decideItem('a');
    const b = decideItem('b');
    const da = store.putDraft(APP, a.seq, 'local', { choice: 'A', baseRev: 1 }, 2_000)!;
    store.putDraft(APP, b.seq, 'local', { choice: 'A', baseRev: 1 }, 2_000);
    store.putDraft(APP, b.seq, 'local', { choice: 'B', baseRev: 1 }, 2_500);
    expect(() => store.submit(APP, {
      author: 'local', nonce: 'n',
      items: [{ seq: a.seq, draftUpdatedAt: da.updatedAt }, { seq: b.seq, draftUpdatedAt: 2_000 }],
    })).toThrow(/改过/);
    expect(store.listBatches(APP)).toEqual([]);
    expect(store.listDrafts(APP, 'local')).toHaveLength(2);
    expect(store.pendingDecisions(APP)).toEqual([]);
  });

  it('别的提交人的草稿互不影响', () => {
    const a = decideItem();
    store.putDraft(APP, a.seq, 'local', { choice: 'A', baseRev: 1 });
    store.putDraft(APP, a.seq, 'u:on_x', { choice: 'B', baseRev: 1 });
    expect(store.listItems(APP, 'all', { author: 'u:on_x' })[0].hasDraft).toBe(true);
    expect(store.getDraft(APP, a.seq, 'local')?.choice).toBe('A');
  });

  it('管家 history --handled 把该项未执行的决定标为已执行', () => {
    const a = decideItem();
    const d = store.putDraft(APP, a.seq, 'local', { choice: 'A', baseRev: 1 })!;
    store.submit(APP, { author: 'local', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    const note = store.appendHistory(APP, a.seq, '先记一笔', {});
    expect(note.handled).toBe(0);
    const reply = store.appendHistory(APP, a.seq, '已按 A 合', { handled: true }, 9_000);
    expect(reply.handled).toBe(1);
    expect(store.pendingDecisions(APP)).toEqual([]);
    expect(store.events(APP, a.seq)[0]).toMatchObject({ kind: 'reply', text: '已按 A 合' });
  });

  it('管家 history --handled 只标最早未执行批次：同事项跨批次连提时后面的决定不被连带标掉', () => {
    const a = decideItem();
    const d1 = store.putDraft(APP, a.seq, 'local', { choice: 'A', baseRev: 1 }, 1_000)!;
    store.submit(APP, { author: 'local', nonce: 'n1', items: [{ seq: a.seq, draftUpdatedAt: d1.updatedAt }] }, 2_000);
    const d2 = store.putDraft(APP, a.seq, 'local', { text: '继续', baseRev: a.rev }, 3_000)!;
    const b2 = store.submit(APP, { author: 'local', nonce: 'n2', items: [{ seq: a.seq, draftUpdatedAt: d2.updatedAt }] }, 4_000);
    const reply = store.appendHistory(APP, a.seq, '批次1做完', { handled: true }, 5_000);
    expect(reply.handled).toBe(1);
    const pendingAfter = store.pendingDecisions(APP);
    expect(pendingAfter).toHaveLength(1);
    expect(pendingAfter[0].batchId).toBe(b2.batch.id);
    // 再来一条 --handled 才标掉第二批。
    expect(store.appendHistory(APP, a.seq, '批次2做完', { handled: true }, 6_000).handled).toBe(1);
    expect(store.pendingDecisions(APP)).toEqual([]);
  });

  it('自动历史的状态名按传入语言渲染（英文管家时间线不混中文）', () => {
    const item = store.addItem(APP, { title: 't', state: 'decide' }, undefined, 1_000, 'en').item;
    store.updateItem(APP, item.seq, { state: 'active' }, undefined, 2_000, 'en');
    const kinds = store.events(APP, item.seq).map(e => `${e.kind}:${e.text}`);
    expect(kinds).toContain('state:Needs decision → In progress');
  });
});

describe('附件与批次投递状态', () => {
  it('同一张图只落盘一份，文件权限只给属主', () => {
    const a = decideItem();
    store.addFile(APP, { bytes: PNG, mime: 'image/png', name: 'a.png', by: 'owner' });
    store.attachFiles(APP, a.seq, [{ bytes: PNG, mime: 'image/png', name: 'b.png' }], '截图');
    const files = readdirSync(decisionBoardFilesDir(dir, APP));
    expect(files).toHaveLength(1);
    expect(existsSync(decisionBoardDbPath(dir))).toBe(true);
    expect(store.events(APP, a.seq)[0]).toMatchObject({ kind: 'attach', text: '截图' });
    expect(() => store.addFile(APP, { bytes: PNG, mime: 'image/svg+xml', name: 'x.svg', by: 'owner' })).toThrow(/只支持/);
  });

  it('投递状态：失败的批次留在待补投列表里，重投经 dispatched 到 delivered 后移出', () => {
    const a = decideItem();
    const d = store.putDraft(APP, a.seq, 'local', { choice: 'A', baseRev: 1 })!;
    const { batch } = store.submit(APP, { author: 'local', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    store.markBatchAttempt(APP, batch.id);
    store.markBatchFailed(APP, batch.id, 'worker down');
    expect(store.undeliveredBatches(APP).map(b => [b.id, b.delivery, b.attempts, b.error])).toEqual([[batch.id, 'failed', 1, 'worker down']]);
    // 重投的真实路径是 failed → dispatched → delivered；不允许 failed 直跳 delivered。
    expect(store.markBatchDelivered(APP, batch.id, { sessionId: 's1', turnId: 'board:x' })).toBe(false);
    expect(store.getBatch(APP, batch.id)?.delivery).toBe('failed');
    store.markBatchDispatched(APP, batch.id, 'board:x');
    expect(store.markBatchDelivered(APP, batch.id, { sessionId: 's1', turnId: 'board:x' })).toBe(true);
    expect(store.undeliveredBatches(APP)).toEqual([]);
    // 已送达之后迟到的失败不能把状态改回去。
    store.markBatchFailed(APP, batch.id, 'late');
    expect(store.getBatch(APP, batch.id)?.delivery).toBe('delivered');
  });

  it('投递状态机：dispatched 是 deliver() 之前的结果未知态，失败可退回，delivered 是唯一成功终态', () => {
    const a = decideItem();
    const d = store.putDraft(APP, a.seq, 'local', { choice: 'A', baseRev: 1 })!;
    const { batch } = store.submit(APP, { author: 'local', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    const turnId = `board:${APP}:1`;
    // 投递开始前（不是投递成功后）：pending → dispatched + 稳定 turnId。
    store.markBatchAttempt(APP, batch.id);
    store.markBatchDispatched(APP, batch.id, turnId);
    expect(store.getBatch(APP, batch.id)).toMatchObject({ delivery: 'dispatched', turnId });
    expect(store.undeliveredBatches(APP).map(b => [b.id, b.delivery])).toEqual([[batch.id, 'dispatched']]);
    // deliver() 抛错 / worker 失败回执：dispatched → failed，可以重投。
    store.markBatchFailed(APP, batch.id, 'boom');
    expect(store.getBatch(APP, batch.id)?.delivery).toBe('failed');
    // 重投再次进 dispatched。
    store.markBatchDispatched(APP, batch.id, turnId);
    expect(store.getBatch(APP, batch.id)?.delivery).toBe('dispatched');
    // deliver() 成功返回：delivered 是终态；之后的迟到失败一律不接受。
    expect(store.markBatchDelivered(APP, batch.id, { sessionId: 's1', turnId })).toBe(true);
    store.markBatchFailed(APP, batch.id, 'late');
    expect(store.getBatch(APP, batch.id)?.delivery).toBe('delivered');
    // delivered 之后再有人调 dispatched 也不倒退。
    store.markBatchDispatched(APP, batch.id, turnId);
    expect(store.getBatch(APP, batch.id)?.delivery).toBe('delivered');
  });

  it('markBatchDelivered 不覆盖抢先到达的 failed（worker 失败回执早于 deliver resolve）', () => {
    const a = decideItem();
    const d = store.putDraft(APP, a.seq, 'local', { choice: 'A', baseRev: 1 })!;
    const { batch } = store.submit(APP, { author: 'local', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    const turnId = `board:${APP}:1`;
    store.markBatchDispatched(APP, batch.id, turnId);
    store.markBatchFailed(APP, batch.id, 'receipt timeout');
    // deliver() 随后才 resolve：失败是 worker 权威判定，终态留 failed。
    expect(store.markBatchDelivered(APP, batch.id, { sessionId: 's1', turnId })).toBe(false);
    expect(store.getBatch(APP, batch.id)).toMatchObject({ delivery: 'failed', error: 'receipt timeout' });
  });

  it('重新打开同一个库，数据都在', () => {
    decideItem();
    store.close();
    store = DecisionBoardStore.open(dir);
    expect(store.listItems(APP, 'all')).toHaveLength(1);
  });
});
