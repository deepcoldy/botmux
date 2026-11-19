/**
 * 决策看板持久层：事项的增改与自动历史、视图分组、草稿、一次提交一批（事务、nonce 去重、
 * 草稿被改过即拒）、管家回写已执行、附件落盘、批次投递状态。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
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

/** 直接读 board_files.ord 列（按 ord 排）。 */
function fileOrds(app: string): Array<{ name: string; ord: number }> {
  const raw = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
  try {
    return raw.prepare('SELECT name, ord FROM board_files WHERE app_id = ? ORDER BY ord').all(app) as Array<{ name: string; ord: number }>;
  } finally {
    raw.close();
  }
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

  it('同毫秒写入的关联保持写入顺序（created_at 打平时不退回 kind 字母序）', () => {
    // 显式钉同一毫秒：CLI 在一次动作里先 add 再 update 时两次 Date.now() 可能相同。
    const item = store.addItem(APP, { title: 't', links: [{ kind: 'pr', ref: 'o/r#1' }] }, undefined, 1000).item;
    store.updateItem(APP, item.seq,
      { links: [{ kind: 'pr', ref: 'o/r#1', label: '主 PR' }, { kind: 'chat', ref: 'oc_abc' }] },
      undefined, 1000);
    expect(store.links(APP, item.seq)).toEqual([
      { kind: 'pr', ref: 'o/r#1', label: '主 PR' },
      { kind: 'chat', ref: 'oc_abc' },
    ]);
    // 单次写入多条、同毫秒时也按数组给出的顺序，不按 kind 字母序。
    const other = store.addItem(APP, {
      title: 't2',
      links: [{ kind: 'pr', ref: 'o/r#2' }, { kind: 'chat', ref: 'oc_def' }, { kind: 'doc', ref: 'https://x' }],
    }, undefined, 2000).item;
    expect(store.links(APP, other.seq).map(l => l.kind)).toEqual(['pr', 'chat', 'doc']);
  });

  it('更新已有关联的 label 不占用新序号（ord 无空洞，严格等于出现顺序）', () => {
    const item = store.addItem(APP, { title: 't', links: [{ kind: 'pr', ref: 'o/r#1' }] }).item;
    // 同一次调用里：pr 是已有关联（只改 label），chat 是新关联——chat 必须拿到 ord 1 而不是 2。
    store.updateItem(APP, item.seq, {
      links: [{ kind: 'pr', ref: 'o/r#1', label: '新标签' }, { kind: 'chat', ref: 'oc_gap' }],
    });
    const raw = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    const ords = raw.prepare('SELECT kind, ord FROM board_links WHERE app_id = ? ORDER BY ord').all(APP);
    raw.close();
    expect(ords).toEqual([{ kind: 'pr', ord: 0 }, { kind: 'chat', ord: 1 }]);
    expect(store.links(APP, item.seq).find(l => l.kind === 'pr')?.label).toBe('新标签');
  });
});

describe('删关联', () => {
  it('先按原文精确删；原文没有再按去掉标签的 ref 删；删完记一条历史', () => {
    // 修复前 doc=https://…|标签 会把「|标签」拼进 ref 存下来：这种旧关联要能照原文删掉，
    // 且同一项里正确的那条（ref 不带标签）不被连带删掉。
    const item = store.addItem(APP, { title: 't', links: [
      { kind: 'doc', ref: 'https://x/d.md|看板文档' },
      { kind: 'doc', ref: 'https://x/d.md', label: '看板文档' },
      { kind: 'pr', ref: 'o/r#1' },
    ] }).item;
    store.updateItem(APP, item.seq, { unlinks: [{ kind: 'doc', raw: 'https://x/d.md|看板文档', ref: 'https://x/d.md' }] }, 'sess-1');
    expect(store.links(APP, item.seq)).toEqual([
      { kind: 'doc', ref: 'https://x/d.md', label: '看板文档' },
      { kind: 'pr', ref: 'o/r#1' },
    ]);
    store.updateItem(APP, item.seq, { unlinks: [{ kind: 'doc', raw: 'https://x/d.md|看板文档', ref: 'https://x/d.md' }] }, 'sess-1');
    expect(store.links(APP, item.seq)).toEqual([{ kind: 'pr', ref: 'o/r#1' }]);
    const linkEvents = store.events(APP, item.seq).filter(e => e.kind === 'link').map(e => e.text);
    expect(linkEvents.slice(0, 2)).toEqual(['移除 doc=https://x/d.md', '移除 doc=https://x/d.md|看板文档']);
  });

  it('同一次改动里先删后加 = 替换；对不上的关联报错，整次改动都不生效', () => {
    const item = store.addItem(APP, { title: 't', links: [{ kind: 'pr', ref: 'o/r#1' }] }).item;
    store.updateItem(APP, item.seq, { unlinks: [{ kind: 'pr', raw: 'o/r#1' }], links: [{ kind: 'pr', ref: 'o/r#2' }] });
    expect(store.links(APP, item.seq)).toEqual([{ kind: 'pr', ref: 'o/r#2' }]);
    // 删同一条后再加回来：不被主键冲突挡住，顺序排到最后。
    store.updateItem(APP, item.seq, { links: [{ kind: 'chat', ref: 'oc_a' }] });
    store.updateItem(APP, item.seq, { unlinks: [{ kind: 'pr', raw: 'o/r#2' }], links: [{ kind: 'pr', ref: 'o/r#2', label: '新' }] });
    expect(store.links(APP, item.seq)).toEqual([{ kind: 'chat', ref: 'oc_a' }, { kind: 'pr', ref: 'o/r#2', label: '新' }]);

    expect(() => store.updateItem(APP, item.seq, {
      stage: '在修', unlinks: [{ kind: 'pr', raw: 'o/r#9' }], links: [{ kind: 'pr', ref: 'o/r#3' }],
    })).toThrow(expect.objectContaining({ code: 'link_not_found' }));
    expect(store.links(APP, item.seq)).toEqual([{ kind: 'chat', ref: 'oc_a' }, { kind: 'pr', ref: 'o/r#2', label: '新' }]);
    expect(store.getItem(APP, item.seq)?.stage).toBeUndefined();
    // 同一次里重复写同一条（原样重复，或带标签 / 不带标签两种写法）按删过了算，不回滚。
    store.updateItem(APP, item.seq, { links: [{ kind: 'doc', ref: 'https://x/d.md' }] });
    store.updateItem(APP, item.seq, { stage: '在审', unlinks: [
      { kind: 'doc', raw: 'https://x/d.md' },
      { kind: 'doc', raw: 'https://x/d.md|L', ref: 'https://x/d.md' },
      { kind: 'doc', raw: 'https://x/d.md' },
    ] });
    expect(store.links(APP, item.seq).map(l => l.kind)).toEqual(['chat', 'pr']);
    expect(store.getItem(APP, item.seq)?.stage).toBe('在审');
    // 类型也要对上：同一个 ref 换个 kind 不算。
    expect(() => store.updateItem(APP, item.seq, { unlinks: [{ kind: 'issue', raw: 'o/r#2' }] }))
      .toThrow(expect.objectContaining({ code: 'link_not_found' }));
  });
});

describe('同一毫秒写入的顺序', () => {
  it('同一毫秒加的关联按加入顺序排，已有的关联更新标签后不挪位置', () => {
    const item = store.addItem(APP, { title: 't', links: [
      { kind: 'url', ref: 'https://z.example' },
      { kind: 'session', ref: 'abcdef12' },
      { kind: 'commit', ref: 'o/r@abcdef1' },
    ] }, undefined, 1_000).item;
    store.updateItem(APP, item.seq, { links: [{ kind: 'chat', ref: 'oc_a' }, { kind: 'url', ref: 'https://z.example', label: '设计' }] }, undefined, 1_000);
    expect(store.links(APP, item.seq).map(l => `${l.kind}${l.label ? `:${l.label}` : ''}`))
      .toEqual(['url:设计', 'session', 'commit', 'chat']);
  });

  it('同一毫秒附的多张图按上传顺序编号（看板内序号从 1 起）', () => {
    const item = decideItem();
    const names = ['f.png', 'a.png', 'e.png', 'b.png'];
    store.attachFiles(APP, item.seq, names.map(name => ({ bytes: PNG, mime: 'image/png', name })), undefined, undefined, 2_000);
    // 直接断言 ord 列：序号算错、占位符漏绑（被静默绑成 NULL）都会让列值本身出错。
    expect(fileOrds(APP)).toEqual([
      { name: 'f.png', ord: 1 }, { name: 'a.png', ord: 2 }, { name: 'e.png', ord: 3 }, { name: 'b.png', ord: 4 },
    ]);
    expect(store.detail(APP, item.seq)!.files.map(f => f.name)).toEqual(names);
    // owner 上传（还没归属事项）也占看板内序号，提交时补 seq 不会撞号。
    store.addFile(APP, { bytes: PNG, mime: 'image/png', name: 'owner.png', by: 'owner' }, 2_000);
    expect(fileOrds(APP).at(-1)).toEqual({ name: 'owner.png', ord: 5 });
    expect(fileOrds(OTHER)).toEqual([]);
  });

  it('列表里时间相同的事项按编号排：待拍板先建的在前，其它视图新建的在前', () => {
    const a = store.addItem(APP, { title: 'a', state: 'decide' }, undefined, 1_000).item;
    const b = store.addItem(APP, { title: 'b', state: 'decide' }, undefined, 1_000).item;
    const c = store.addItem(APP, { title: 'c', state: 'active' }, undefined, 1_000).item;
    const d = store.addItem(APP, { title: 'd', state: 'active' }, undefined, 1_000).item;
    expect(store.listItems(APP, 'decide').map(i => i.seq)).toEqual([a.seq, b.seq]);
    expect(store.listItems(APP, 'active').map(i => i.seq)).toEqual([d.seq, c.seq]);
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

  it('v1 库重新打开时迁移到 v2：items 保留，links 表重建后可正常按顺序写入', () => {
    decideItem();
    store.close();
    // 手工把库降成 v1 并换成无 ord 列的旧 links 表（开发机上唯一可能存在的旧形态）。
    const db = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    db.exec('DROP TABLE board_links;');
    db.exec(`CREATE TABLE board_links (
      app_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
      label TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, seq, kind, ref)
    ) WITHOUT ROWID;`);
    db.exec('PRAGMA user_version = 1;');
    db.close();

    store = DecisionBoardStore.open(dir);
    // items/events 等其余数据保留。
    expect(store.listItems(APP, 'all')).toHaveLength(1);
    // links 表已按 v2 重建：同毫秒多关联保持写入顺序（这是 v2 的修复点）。
    const item = store.listItems(APP, 'all')[0]!;
    store.updateItem(APP, item.seq, {
      links: [{ kind: 'pr', ref: 'o/r#9', label: 'PR' }, { kind: 'chat', ref: 'oc_mig' }],
    }, undefined, 5000);
    expect(store.links(APP, item.seq).map(l => l.kind)).toEqual(['pr', 'chat']);
    store.close();
    // 再开一次已是 v2，不会重复迁移。
    store = DecisionBoardStore.open(dir);
    expect(store.links(APP, item.seq).map(l => l.kind)).toEqual(['pr', 'chat']);
  });

  it('v2 库重新打开时迁移到 v3：board_files 补 ord 并按看板内 (created_at, id) 回填，links 等原有数据都在', () => {
    const item = store.addItem(APP, { title: 't', links: [{ kind: 'pr', ref: 'o/r#1' }, { kind: 'chat', ref: 'oc_a' }] }, undefined, 500).item;
    const other = store.addItem(OTHER, { title: 'o' }, undefined, 500).item;
    store.close();
    // 手工降成 v2 的真实形态：board_files 没有 ord 列。老图同一毫秒、按 id 逆序写入，
    // 回填的 tie-break 写错（id DESC）或漏按 app_id 分区都会让下面的断言变红。
    const db = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    db.exec('DROP TABLE board_files;');
    db.exec(`CREATE TABLE board_files (
      app_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER, sha256 TEXT NOT NULL, mime TEXT NOT NULL,
      bytes INTEGER NOT NULL, name TEXT NOT NULL, uploader TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, id)
    ) WITHOUT ROWID;`);
    const seed = db.prepare(`INSERT INTO board_files (app_id, id, seq, sha256, mime, bytes, name, uploader, created_at)
      VALUES (?, ?, ?, 'x', 'image/png', 1, ?, 'steward', ?)`);
    for (const id of ['zz', 'aa', 'mm', 'bb']) seed.run(APP, id, item.seq, `${id[0]}.png`, 1_000);
    seed.run(OTHER, 'aa', other.seq, 'y.png', 1_000);
    seed.run(OTHER, 'cc', other.seq, 'c.png', 900);
    db.exec('PRAGMA user_version = 2;');
    db.close();

    store = DecisionBoardStore.open(dir);
    expect(fileOrds(APP)).toEqual([
      { name: 'a.png', ord: 1 }, { name: 'b.png', ord: 2 }, { name: 'm.png', ord: 3 }, { name: 'z.png', ord: 4 },
    ]);
    expect(fileOrds(OTHER)).toEqual([{ name: 'c.png', ord: 1 }, { name: 'y.png', ord: 2 }]);
    expect(store.detail(APP, item.seq)!.files.map(f => f.name)).toEqual(['a.png', 'b.png', 'm.png', 'z.png']);
    // v2 的 links 数据原样保留（v1→v2 是丢表重建，链式迁移容易连带丢掉它）。
    expect(store.links(APP, item.seq).map(l => l.kind)).toEqual(['pr', 'chat']);
    // 迁移后新附的图接在后面。
    store.attachFiles(APP, item.seq, [{ bytes: PNG, mime: 'image/png', name: 'new.png' }], undefined, undefined, 1_000);
    expect(fileOrds(APP).at(-1)).toEqual({ name: 'new.png', ord: 5 });
    // 序号按看板（app_id）各自计数，别的管家的看板不受影响。
    store.attachFiles(OTHER, other.seq, [{ bytes: PNG, mime: 'image/png', name: 'other-new.png' }], undefined, undefined, 1_000);
    expect(fileOrds(OTHER).at(-1)).toEqual({ name: 'other-new.png', ord: 3 });
    store.close();

    const check = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    check.close();
    // 再开一次已是 v3，不会重复回填。
    store = DecisionBoardStore.open(dir);
    expect(fileOrds(APP).map(f => f.ord)).toEqual([1, 2, 3, 4, 5]);
  });

  it('v1 库重新打开时一次迁到 v3：links 丢表重建、board_files 补 ord 回填，版本变 3', () => {
    const item = store.addItem(APP, { title: 't', links: [{ kind: 'url', ref: 'https://old.example' }] }, undefined, 500).item;
    store.close();
    // 降成 v1 的真实形态：board_links 与 board_files 都没有 ord 列；老图同一毫秒、按 id 逆序写入。
    const db = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    db.exec('DROP TABLE board_links;');
    db.exec(`CREATE TABLE board_links (
      app_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
      label TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, seq, kind, ref)
    ) WITHOUT ROWID;`);
    db.exec('DROP TABLE board_files;');
    db.exec(`CREATE TABLE board_files (
      app_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER, sha256 TEXT NOT NULL, mime TEXT NOT NULL,
      bytes INTEGER NOT NULL, name TEXT NOT NULL, uploader TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, id)
    ) WITHOUT ROWID;`);
    const seed = db.prepare(`INSERT INTO board_files (app_id, id, seq, sha256, mime, bytes, name, uploader, created_at)
      VALUES (?, ?, ?, 'x', 'image/png', 1, ?, 'steward', ?)`);
    for (const id of ['zz', 'aa', 'mm', 'bb']) seed.run(APP, id, item.seq, `${id[0]}.png`, 1_000);
    db.exec('PRAGMA user_version = 1;');
    db.close();

    store = DecisionBoardStore.open(dir);
    // v1→v2 是丢表重建（#2282 的既定行为，老关联不保留）：重建后新写的关联按写入顺序。
    store.updateItem(APP, item.seq, { links: [{ kind: 'pr', ref: 'o/r#9' }, { kind: 'chat', ref: 'oc_v1' }] }, undefined, 5_000);
    expect(store.links(APP, item.seq).map(l => l.kind)).toEqual(['pr', 'chat']);
    expect(fileOrds(APP)).toEqual([
      { name: 'a.png', ord: 1 }, { name: 'b.png', ord: 2 }, { name: 'm.png', ord: 3 }, { name: 'z.png', ord: 4 },
    ]);
    expect(store.detail(APP, item.seq)!.files.map(f => f.name)).toEqual(['a.png', 'b.png', 'm.png', 'z.png']);
    const check = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    check.close();
  });

  it('v2→v3 回填在大图上一次排名完成：万行附件量级迁移不退化成逐行 COUNT，序号与 (created_at, id) 参考序逐行一致', () => {
    const item = store.addItem(APP, { title: 't' }, undefined, 500).item;
    const other = store.addItem(OTHER, { title: 'o' }, undefined, 500).item;
    store.close();
    // 手工降成 v2 的真实形态（board_files 没有 ord 列），按 #2298 的规模造数据：附件不清理、
    // 不限条数，两个看板共 3 万行，约 1/4 行与前一行的 created_at 打平（同毫秒并列按 id 定序），
    // id 写入顺序打乱。逐行 COUNT 的相关子查询在这个量级是 O(n²)，卡在 open() 的写锁里。
    const db = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    db.exec('DROP TABLE board_files;');
    db.exec(`CREATE TABLE board_files (
      app_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER, sha256 TEXT NOT NULL, mime TEXT NOT NULL,
      bytes INTEGER NOT NULL, name TEXT NOT NULL, uploader TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, id)
    ) WITHOUT ROWID;`);
    const seed = db.prepare(`INSERT INTO board_files (app_id, id, seq, sha256, mime, bytes, name, uploader, created_at)
      VALUES (?, ?, ?, 'x', 'image/png', 1, ?, 'steward', ?)`);
    const TOTAL = 30_000;
    const rows: Array<{ app: string; id: string; createdAt: number }> = [];
    db.exec('BEGIN');
    for (let i = 0; i < TOTAL; i++) {
      const app = i % 2 === 0 ? APP : OTHER;
      // 打乱 id；两个看板共享 shared-file，但其看板内排名不同，守住回填 join 的 app_id 条件。
      const id = i === 0 || i === 5 ? 'shared-file' : `f${(i * 7919) % 104729}`;
      // 每 4 行共享一个毫秒：并列组内的相对顺序只能由 id 决定。
      const createdAt = 1_700_000_000_000 + Math.floor(i / 4) * 3;
      seed.run(app, id, app === APP ? item.seq : other.seq, `${id}.png`, createdAt);
      rows.push({ app, id, createdAt });
    }
    db.exec('COMMIT');
    db.exec('PRAGMA user_version = 2;');
    db.close();

    const t0 = performance.now();
    store = DecisionBoardStore.open(dir);
    const elapsed = performance.now() - t0;
    // 参考序：与迁移契约相同——按 app_id 分区、(created_at, id) 升序、从 1 编号。
    const expected = new Map<string, number>();
    for (const app of [APP, OTHER]) {
      rows.filter(r => r.app === app)
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
        .forEach((r, i) => expected.set(`${app}\u0000${r.id}`, i + 1));
    }
    const raw = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    const actual = raw.prepare('SELECT app_id, id, ord FROM board_files').all() as Array<{ app_id: string; id: string; ord: number }>;
    raw.close();
    expect(expected.get(`${APP}\u0000shared-file`)).not.toBe(expected.get(`${OTHER}\u0000shared-file`));
    expect(actual).toHaveLength(TOTAL);
    for (const r of actual) {
      expect(r.ord).toBe(expected.get(`${r.app_id}\u0000${r.id}`));
    }
    // 迁移在冷启动路径上，写锁内的耗时用户直接可感：参考机器上万行相关子查询要数秒，
    // 一次排名是十几毫秒量级。这里给足余量，守住的是「不能退化回逐行 COUNT」。
    expect(elapsed).toBeLessThan(5_000);
    // 迁移后的序号仍可续写：新附的图接在本看板末尾。
    store.attachFiles(APP, item.seq, [{ bytes: PNG, mime: 'image/png', name: 'next.png' }], undefined, undefined, 6_000);
    expect(fileOrds(APP).at(-1)).toEqual({ name: 'next.png', ord: TOTAL / 2 + 1 });
  }, 60_000);

  it('库的版本比本构建新时明确报错，不读写', () => {
    store.close();
    const db = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    db.exec('PRAGMA user_version = 4;');
    db.close();
    expect(() => DecisionBoardStore.open(dir)).toThrow(/has schema v4, newer than this botmux \(v3\)/);
    // 版本号原样保留（没被改写成 v3），恢复后让 afterEach 正常关库。
    const after = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4);
    after.exec('PRAGMA user_version = 3;');
    after.close();
    store = DecisionBoardStore.open(dir);
  });
});

describe('群关联：主群、无群原因、核实状态', () => {
  const chat = (ref: string, extra: Partial<{ label: string; chatCheck: 'verified' | 'unverified'; chatName: string }> = {}) => ({ kind: 'chat' as const, ref, ...extra });

  it('核实状态随关联存取；同一个群再写一遍 = 重新核实：补上群名和状态，不另起一条、不挪位置', () => {
    const item = store.addItem(APP, { title: 't', links: [chat('oc_a'), { kind: 'pr', ref: 'o/r#1' }] }, undefined, 1_000).item;
    expect(store.links(APP, item.seq)).toEqual([{ kind: 'chat', ref: 'oc_a' }, { kind: 'pr', ref: 'o/r#1' }]);
    store.updateItem(APP, item.seq, { links: [chat('oc_a', { label: '任务群', chatCheck: 'verified' })] }, undefined, 2_000);
    expect(store.links(APP, item.seq)).toEqual([
      { kind: 'chat', ref: 'oc_a', label: '任务群', chatCheck: 'verified' }, { kind: 'pr', ref: 'o/r#1' },
    ]);
    // 核实结果以最新一次为准。
    store.updateItem(APP, item.seq, { links: [chat('oc_a', { chatCheck: 'unverified' })] }, undefined, 3_000);
    expect(store.links(APP, item.seq)[0]).toEqual({ kind: 'chat', ref: 'oc_a', label: '任务群', chatCheck: 'unverified' });
  });

  it('群名和管家的标签分开存：重新核实刷新群名，不动标签；核实状态和群名作为一个整体覆盖，乱序落库也不会自相矛盾', () => {
    const item = store.addItem(APP, { title: 't', links: [chat('oc_a', { label: '评审群', chatName: '群名 1', chatCheck: 'verified' })] }).item;
    store.updateItem(APP, item.seq, { links: [chat('oc_a', { chatName: '群名 2', chatCheck: 'verified' })] });
    expect(store.links(APP, item.seq)).toEqual([{ kind: 'chat', ref: 'oc_a', label: '评审群', chatName: '群名 2', chatCheck: 'verified' }]);
    expect(store.listItems(APP, 'all', { query: '群名 2' }).map(i => i.seq)).toEqual([item.seq]);
    // 后落库的是「查不到」（未核实、没有群名）：两列一起换掉，不留下「未核实 + 新群名」。
    store.updateItem(APP, item.seq, { links: [chat('oc_a', { chatCheck: 'unverified' })] });
    expect(store.links(APP, item.seq)).toEqual([{ kind: 'chat', ref: 'oc_a', label: '评审群', chatCheck: 'unverified' }]);
    // 不带核实结果的重写（如只改标签）两列都不动。
    store.updateItem(APP, item.seq, { links: [chat('oc_a', { chatName: '群名 3', chatCheck: 'verified' })] });
    store.updateItem(APP, item.seq, { links: [chat('oc_a', { label: '新标签' })] });
    expect(store.links(APP, item.seq)).toEqual([{ kind: 'chat', ref: 'oc_a', label: '新标签', chatName: '群名 3', chatCheck: 'verified' }]);
  });

  it('打开库时收拾回滚期间旧构建留下的不一致：失效的主群指定、已有群的无群原因', () => {
    const a = store.addItem(APP, { title: 'a', links: [chat('oc_a'), chat('oc_b')], primaryChat: 'oc_b' }).item;
    const b = store.addItem(APP, { title: 'b', noChatReason: '只有 issue' }).item;
    const c = store.addItem(APP, { title: 'c', links: [chat('oc_c'), chat('oc_d')], primaryChat: 'oc_d' }).item;
    store.close();
    // 旧构建：删关联不清主群、挂群不清原因。
    const old = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    old.prepare(`DELETE FROM board_links WHERE app_id = ? AND seq = ? AND ref = 'oc_b'`).run(APP, a.seq);
    old.prepare(`INSERT INTO board_links (app_id, seq, kind, ref, label, created_at, ord) VALUES (?, ?, 'chat', 'oc_new', NULL, 9, 0)`).run(APP, b.seq);
    old.close();
    store = DecisionBoardStore.open(dir);
    expect(store.getItem(APP, a.seq)!.primaryChat).toBeUndefined();
    expect(store.getItem(APP, b.seq)!.noChatReason).toBeUndefined();
    // 正常数据不动。
    expect(store.getItem(APP, c.seq)!.primaryChat).toBe('oc_d');
    // 失效指定清掉后，那个群再挂回来不会悄悄复位成主群。
    store.updateItem(APP, a.seq, { links: [chat('oc_b')] });
    expect(store.getItem(APP, a.seq)!.primaryChat).toBeUndefined();
  });

  it('主群必须是这一项的群；删掉主群那条关联后不留失效的指定（以后再挂回来也不悄悄复位）', () => {
    const item = store.addItem(APP, { title: 't', links: [chat('oc_a'), chat('oc_b')], primaryChat: 'oc_b' }, undefined, 1_000).item;
    expect(item.primaryChat).toBe('oc_b');
    expect(() => store.updateItem(APP, item.seq, { primaryChat: 'oc_x' })).toThrow(expect.objectContaining({ code: 'primary_chat_not_linked' }));
    // 同一次里先删再指定被删的那个：整次不生效。
    expect(() => store.updateItem(APP, item.seq, { unlinks: [{ kind: 'chat', raw: 'oc_a' }], primaryChat: 'oc_a' }))
      .toThrow(expect.objectContaining({ code: 'primary_chat_not_linked' }));
    expect(store.links(APP, item.seq).map(l => l.ref)).toEqual(['oc_a', 'oc_b']);
    store.updateItem(APP, item.seq, { unlinks: [{ kind: 'chat', raw: 'oc_b' }] }, undefined, 2_000);
    expect(store.getItem(APP, item.seq)!.primaryChat).toBeUndefined();
    store.updateItem(APP, item.seq, { links: [chat('oc_b')] }, undefined, 3_000);
    expect(store.getItem(APP, item.seq)!.primaryChat).toBeUndefined();
    // 指定主群记一条历史。
    store.updateItem(APP, item.seq, { primaryChat: 'oc_b' }, 'sess-9', 4_000);
    expect(store.events(APP, item.seq)[0]).toMatchObject({ kind: 'link', text: '主群 → chat=oc_b', actorRef: 'sess-9' });
  });

  it('无群原因：有群时不收；没群时记下并进历史；之后挂上群自动清掉，群再删光就重新算缺群', () => {
    expect(() => store.addItem(APP, { title: 't', links: [chat('oc_a')], noChatReason: '没有群' }))
      .toThrow(expect.objectContaining({ code: 'no_chat_conflict' }));
    const withChat = store.addItem(APP, { title: '有群', links: [chat('oc_a')] }, undefined, 1_000).item;
    expect(() => store.updateItem(APP, withChat.seq, { noChatReason: '其实没有' })).toThrow(expect.objectContaining({ code: 'chat_already_linked' }));
    expect(store.getItem(APP, withChat.seq)!.noChatReason).toBeUndefined();

    const item = store.addItem(APP, { title: '只有 issue', noChatReason: '只有 issue，还没开工' }, 'sess-1', 2_000).item;
    expect(item.noChatReason).toBe('只有 issue，还没开工');
    expect(store.events(APP, item.seq).map(e => e.text)).toContain('无群：只有 issue，还没开工');
    store.updateItem(APP, item.seq, { links: [chat('oc_new')] }, undefined, 3_000);
    expect(store.getItem(APP, item.seq)!.noChatReason).toBeUndefined();
    store.updateItem(APP, item.seq, { unlinks: [{ kind: 'chat', raw: 'oc_new' }] }, undefined, 4_000);
    expect(store.getItem(APP, item.seq)!.noChatReason).toBeUndefined();
    expect(store.links(APP, item.seq)).toEqual([]);
    expect(() => store.addItem(APP, { title: 'x', noChatReason: '   ' })).toThrow(expect.objectContaining({ code: 'no_chat_reason_required' }));
    expect(() => store.addItem(APP, { title: 'x', noChatReason: '长'.repeat(201) })).toThrow(expect.objectContaining({ code: 'field_too_long' }));
  });

  it('搜索也认群名（标签）', () => {
    store.addItem(APP, { title: '登录页重构', links: [chat('oc_a', { label: '前端评审群' })] });
    store.addItem(APP, { title: '别的事', noChatReason: '无' });
    expect(store.listItems(APP, 'all', { query: '评审群' }).map(i => i.title)).toEqual(['登录页重构']);
  });

  it('改动前建的库：打开时补上三列，旧行原样读出；补列后旧构建的写法（不带新列）照样写得进去', () => {
    const item = store.addItem(APP, { title: 'old', links: [chat('oc_old'), { kind: 'pr', ref: 'o/r#1' }] }, undefined, 500).item;
    store.close();
    // 手工降成改动前的形态：去掉三列，再用旧构建的 INSERT 写一条旧关联。
    const db = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    db.exec('ALTER TABLE board_items DROP COLUMN primary_chat;');
    db.exec('ALTER TABLE board_items DROP COLUMN no_chat_reason;');
    db.exec('ALTER TABLE board_links DROP COLUMN chat_check;');
    db.exec('ALTER TABLE board_links DROP COLUMN chat_name;');
    db.prepare(`INSERT INTO board_links (app_id, seq, kind, ref, label, created_at, ord) VALUES (?, ?, 'chat', 'oc_legacy', NULL, 600, 2)`)
      .run(APP, item.seq);
    db.close();

    store = DecisionBoardStore.open(dir);
    expect(store.getItem(APP, item.seq)).not.toHaveProperty('primaryChat');
    expect(store.getItem(APP, item.seq)).not.toHaveProperty('noChatReason');
    expect(store.links(APP, item.seq)).toEqual([
      { kind: 'chat', ref: 'oc_old' }, { kind: 'pr', ref: 'o/r#1' }, { kind: 'chat', ref: 'oc_legacy' },
    ]);
    // 补完的库能写新字段。
    store.updateItem(APP, item.seq, { links: [chat('oc_legacy', { chatName: '旧群', chatCheck: 'verified' })], primaryChat: 'oc_legacy' }, undefined, 700);
    expect(store.getItem(APP, item.seq)!.primaryChat).toBe('oc_legacy');
    expect(store.links(APP, item.seq)[2]).toEqual({ kind: 'chat', ref: 'oc_legacy', chatName: '旧群', chatCheck: 'verified' });
    store.close();

    // 回滚到旧构建：它的 INSERT 只写旧列，新列取 NULL；版本号没升，旧构建也不会 fail-closed。
    const old = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    expect((old.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    old.prepare(`INSERT INTO board_items (app_id, seq, item_key, title, state, stage, kind, repo, summary, progress,
      question, options_json, recommend, recommend_reason, rev, created_at, updated_at, state_at)
      VALUES (?, 99, NULL, '旧构建建的', 'active', NULL, NULL, NULL, NULL, NULL, NULL, '[]', NULL, NULL, 1, 800, 800, 800)`).run(APP);
    old.prepare(`INSERT INTO board_links (app_id, seq, kind, ref, label, created_at, ord) VALUES (?, 99, 'chat', 'oc_rollback', NULL, 800, 0)`).run(APP);
    old.close();

    store = DecisionBoardStore.open(dir);
    expect(store.getItem(APP, 99)).toMatchObject({ title: '旧构建建的' });
    expect(store.getItem(APP, 99)).not.toHaveProperty('primaryChat');
    expect(store.links(APP, 99)).toEqual([{ kind: 'chat', ref: 'oc_rollback' }]);
    // 已补过的库再开一次不重复补列。
    store.close();
    store = DecisionBoardStore.open(dir);
    expect(store.getItem(APP, item.seq)!.primaryChat).toBe('oc_legacy');
  });
});
