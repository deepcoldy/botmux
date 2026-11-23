/**
 * 决策看板的父子任务（--parent）与「在等谁」（--waiting-on），用真实的存储和服务：
 *   - 挂上 / 取消上级、记历史；列表和详情带上级、子任务完成情况、最近进展时间；
 *   - 防环、限层数、不能依赖自己的上级（挪动整枝时子孙也查）；校验失败整次不落库；
 *   - 子任务都结束了，开着「自动发现可以关的项」时给大任务标「可以收尾」；
 *   - CLI 解析、list 按树缩进；老库打开时补列。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionBoardService, type DecisionBoardServiceDeps } from '../src/core/decision-board/service.js';
import type { StewardConfig } from '../src/core/decision-board/model.js';
import { BOARD_TREE_MAX_DEPTH, boardCheckStatus } from '../src/core/decision-board/overview.js';
import { formatBoardResult, parseBoardArgs } from '../src/cli/board-command.js';
import { riffHostFileArguments } from '../src/services/riff-host-tools.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { DecisionBoardStore, decisionBoardDbPath } from '../src/services/decision-board-store.js';

const APP = 'cli_steward';
const DAY = 86_400_000;

let dir: string;
let steward: StewardConfig | undefined;
let delivered: Array<Parameters<DecisionBoardServiceDeps['deliver']>[0]>;
let service: DecisionBoardService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-board-tree-'));
  steward = { enabled: true, chatId: 'oc_steward' };
  delivered = [];
  service = new DecisionBoardService({
    dataDir: dir,
    larkAppId: () => APP,
    steward: () => steward,
    locale: () => 'zh',
    brand: () => 'feishu',
    dashboardOrigin: () => 'https://dash.example',
    ownerOpenId: () => 'ou_owner',
    ownerName: async () => '主人',
    timeZone: () => 'UTC',
    batchAttachmentsDir: batchId => join(dir, 'attachments', `board-${batchId}`),
    banner: ({ batchId, count }) => `收到 ${count} 项（#${batchId}）`,
    deliver: async input => { delivered.push(input); return { sessionId: 'sess-steward' }; },
    log: () => {},
    lookupChat: async chatId => ({ ok: true, chatId, appId: APP, name: `群-${chatId}` }),
    prState: async () => undefined,
  });
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

async function add(title: string, extra: Record<string, unknown> = {}): Promise<number> {
  const res = await service.cli({ action: 'add', title, noChat: '用例', ...extra }, { sessionId: 'sess-1' }) as { item: { seq: number } };
  return res.item.seq;
}

const set = (seq: number, extra: Record<string, unknown>) => service.cli({ action: 'set', ref: String(seq), ...extra }, { sessionId: 'sess-1' });
const parentOf = (seq: number) => service.store().getItem(APP, seq)!.parentSeq;

describe('父子任务', () => {
  it('add / set --parent 挂上，none 取消；历史记一句；详情给上级和子任务，列表给子任务完成情况（不受视图影响）', async () => {
    const big = await add('发 v3.60');
    const a = await add('修启动崩溃', { parent: String(big) });
    const b = await add('写发布说明', { parent: `#${big}`, fields: { state: 'decide', question: '这版写哪些？' }, options: ['A=全写', 'B=只写重点'] });
    const c = await add('补 e2e');
    await set(c, { parent: String(big) });
    await set(a, { fields: { state: 'done' } });

    expect([a, b, c].map(parentOf)).toEqual([big, big, big]);
    const detail = service.detail(big, 'owner');
    expect(detail.children.map(ch => [ch.seq, ch.state])).toEqual([[a, 'done'], [b, 'decide'], [c, 'active']]);
    expect(detail.childStats).toEqual({ total: 3, done: 1, closed: 0 });
    expect(service.detail(c, 'owner').parent).toMatchObject({ seq: big, title: '发 v3.60', state: 'active' });
    expect(service.store().events(APP, c).map(e => e.text)).toContain(`上级：#${big} 发 v3.60`);
    expect(service.store().events(APP, a).map(e => e.text)).toContain(`上级：#${big} 发 v3.60`);

    // 「待你拍板」视图里只有 #b，它的上级和大任务的完成情况照样按整张看板算。
    const decide = service.list('decide', 'owner').items;
    expect(decide.map(i => i.seq)).toEqual([b]);
    expect(decide[0]!.parent).toMatchObject({ seq: big });
    const bigRow = service.list('all', 'owner').items.find(i => i.seq === big)!;
    expect(bigRow.childStats).toEqual({ total: 3, done: 1, closed: 0 });

    await set(c, { parent: 'none' });
    expect(parentOf(c)).toBeUndefined();
    expect(service.store().events(APP, c).map(e => e.text)).toContain(`上级：无（原 #${big}）`);
    expect(service.detail(big, 'owner').childStats).toEqual({ total: 2, done: 1, closed: 0 });
  });

  it('父子关系不升 rev（不让草稿标「管家改过」）；只改上级也算改了字段', async () => {
    const big = await add('大任务');
    const child = await add('子任务', { fields: { question: '定不定？' }, options: ['A=定'] });
    const rev = service.store().getItem(APP, child)!.rev;
    await set(child, { parent: String(big) });
    expect(service.store().getItem(APP, child)!.rev).toBe(rev);
  });

  it('防环：不能挂在自己下面、不能挂到自己的子孙下面；上级要存在；失败时什么都不改', async () => {
    const a = await add('A');
    const b = await add('B', { parent: String(a) });
    const c = await add('C', { parent: String(b) });
    await expect(set(a, { parent: String(a) })).rejects.toMatchObject({ code: 'invalid_parent' });
    await expect(set(a, { parent: String(c) })).rejects.toMatchObject({ code: 'parent_cycle' });
    await expect(set(a, { parent: String(b), fields: { stage: '不该落库' } })).rejects.toMatchObject({ code: 'parent_cycle' });
    await expect(set(a, { parent: '999' })).rejects.toMatchObject({ code: 'item_not_found' });
    await expect(add('D', { parent: '999' })).rejects.toMatchObject({ code: 'item_not_found' });
    expect(parentOf(a)).toBeUndefined();
    expect(service.store().getItem(APP, a)!.stage).toBeUndefined();
    expect(service.list('all', 'owner').items.map(i => i.title)).not.toContain('D');
  });

  it(`限层数：整棵树最多 ${BOARD_TREE_MAX_DEPTH} 层，挪一整枝时按挪过去之后的深度算`, async () => {
    const chain: number[] = [await add('L1')];
    for (let n = 2; n <= BOARD_TREE_MAX_DEPTH; n++) chain.push(await add(`L${n}`, { parent: String(chain[chain.length - 1]) }));
    await expect(add('太深', { parent: String(chain[chain.length - 1]) })).rejects.toMatchObject({ code: 'tree_too_deep' });
    // 两层的小树挂到第 5 层下面：5 + 2 = 7 层，拒绝；挂到第 4 层下面：刚好 6 层。
    const top = await add('小树');
    await add('小树的子任务', { parent: String(top) });
    await expect(set(top, { parent: String(chain[4]) })).rejects.toMatchObject({ code: 'tree_too_deep' });
    await set(top, { parent: String(chain[3]) });
    expect(parentOf(top)).toBe(chain[3]);
  });

  it('依赖是「等它先做完」，父子是「它是我的一部分」：不能依赖自己的上级（各个方向都挡），依赖兄弟或子任务可以', async () => {
    const big = await add('大任务');
    const child = await add('子任务', { parent: String(big) });
    const grand = await add('孙任务', { parent: String(child) });
    const sibling = await add('兄弟', { parent: String(big) });
    await expect(set(child, { dependsOn: String(big) })).rejects.toMatchObject({ code: 'depends_on_ancestor' });
    await expect(set(grand, { dependsOn: `${sibling},${big}` })).rejects.toMatchObject({ code: 'depends_on_ancestor' });
    await expect(add('新子任务', { parent: String(big), dependsOn: String(big) })).rejects.toMatchObject({ code: 'depends_on_ancestor' });
    await set(child, { dependsOn: String(sibling) });
    await set(big, { dependsOn: String(child) });

    // 先依赖、后挂上去：挂上之后依赖的那一项成了上级，拒绝。
    const other = await add('另一项');
    const waiter = await add('等另一项', { dependsOn: String(other) });
    await expect(set(waiter, { parent: String(other) })).rejects.toMatchObject({ code: 'depends_on_ancestor' });
    // 挪一整枝：孙任务依赖 #other，把 #other 挂成整棵树的上级，孙任务就依赖了自己的祖先。
    await set(grand, { dependsOn: String(other) });
    await expect(set(big, { parent: String(other) })).rejects.toMatchObject({ code: 'depends_on_ancestor' });
    expect(parentOf(big)).toBeUndefined();
  });

  it('在等谁：写上、none 清空；记历史；不升 rev', async () => {
    const seq = await add('等 PR 作者', { fields: { state: 'waiting' }, waitingOn: 'PR 作者 改评审意见' });
    expect(service.store().getItem(APP, seq)!.waitingOn).toBe('PR 作者 改评审意见');
    const rev = service.store().getItem(APP, seq)!.rev;
    await set(seq, { waitingOn: '评审群双审' });
    expect(service.store().getItem(APP, seq)!).toMatchObject({ waitingOn: '评审群双审', rev });
    await set(seq, { waitingOn: 'none' });
    expect(service.store().getItem(APP, seq)!.waitingOn).toBeUndefined();
    expect(service.store().events(APP, seq).map(e => e.text)).toEqual(expect.arrayContaining(['在等：评审群双审', '在等：无']));
    await expect(set(seq, { waitingOn: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'field_too_long' });
  });

  it('最近进展：管家和 owner 写的历史、字段更新都算；巡检提示、收进历史的草稿不算', async () => {
    const store = service.store();
    const seq = store.addItem(APP, { title: 'x', noChatReason: 'r' }, 's', 1_000).item.seq;
    expect(service.list('all', 'owner').items[0]!.lastActivityAt).toBe(1_000);
    store.appendHistory(APP, seq, '推进了一步', {}, 5_000);
    expect(service.list('all', 'owner').items[0]!.lastActivityAt).toBe(5_000);
    // 系统自动记的提示不算进展。
    store.updateItem(APP, seq, { nextCheckAt: 6_000 }, 's', 5_500);
    store.sweepHints(APP, { now: 9_000, locale: 'zh', prState: () => undefined });
    expect(store.events(APP, seq).some(e => e.actor === 'system')).toBe(true);
    expect(service.list('all', 'owner').items[0]!.lastActivityAt).toBe(5_500);
    expect(service.detail(seq, 'owner').lastActivityAt).toBe(5_500);
  });
});

describe('子任务都结束了：提示大任务可以收尾', () => {
  it('开着巡检时标「建议关闭」：子任务都完成 / 有关闭的写明；还有没结束的、或大任务写了 manual 不标', async () => {
    steward = { enabled: true, chatId: 'oc_steward', closeHints: true };
    const big = await add('大任务');
    const a = await add('A', { parent: String(big) });
    const b = await add('B', { parent: String(big) });
    const manual = await add('只由管家判断', { closeWhen: 'manual' });
    const m1 = await add('M1', { parent: String(manual) });
    await set(a, { fields: { state: 'done' } });
    await service.sweepHints(Date.now());
    expect(service.store().getItem(APP, big)!.hint).toBeUndefined();

    await set(b, { fields: { state: 'closed' } });
    await set(m1, { fields: { state: 'done' } });
    await service.sweepHints(Date.now());
    expect(service.store().getItem(APP, big)!.hint).toMatchObject({
      kind: 'close', key: `close:children:${service.store().getItem(APP, b)!.stateAt}`, reason: `子任务 #${a}、#${b} 都已结束（#${b} 是关闭，不是完成），可以收尾`,
    });
    expect(service.store().getItem(APP, manual)!.hint).toBeUndefined();
    expect(delivered.at(-1)!.prompt).toContain('可以收尾');
  });

  it('巡检没开：只在看板上标「可以收尾」（列表给子任务完成情况），不给提示、不发通知', async () => {
    const big = await add('大任务');
    const a = await add('A', { parent: String(big) });
    await set(a, { fields: { state: 'done' } });
    expect(await service.sweepHints(Date.now())).toBeUndefined();
    expect(service.store().getItem(APP, big)!.hint).toBeUndefined();
    expect(service.list('all', 'owner').items.find(i => i.seq === big)!.childStats).toEqual({ total: 1, done: 1, closed: 0 });
    expect(delivered).toEqual([]);
  });
});

describe('复核补充：收尾提示的轮次、最近进展、复查口径、在等谁、坏数据', () => {
  const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);
  const H = 3_600_000;
  const store = () => service.store();
  const mk = (title: string, patch: Record<string, unknown>, at: number) => store().addItem(APP, { title, noChatReason: 'r', ...patch }, 's', at).item.seq;
  const upd = (seq: number, patch: Record<string, unknown>, at: number) => store().updateItem(APP, seq, patch, 's', at);
  const hintNotices = () => delivered.filter(d => d.prompt.includes('可以收尾')).length;

  it('通知过「可以收尾」后子任务重开、再由 owner 在看板上关掉：算新的一轮，再通知一次', async () => {
    steward = { enabled: true, chatId: 'oc_steward', closeHints: true };
    const big = mk('大任务', {}, T0);
    const a = mk('A', { parentSeq: big }, T0);
    const b = mk('B', { parentSeq: big }, T0);
    upd(a, { state: 'done' }, T0 + H);
    upd(b, { state: 'done' }, T0 + 2 * H);
    await service.sweepHints(T0 + 3 * H);
    expect(hintNotices()).toBe(1);
    // 管家把 B 重开去问 owner：大任务的「可以收尾」立刻清掉，不等下一轮巡检。
    upd(b, { state: 'decide', question: '还要做吗？' }, T0 + 4 * H);
    expect(store().getItem(APP, big)!.hint).toBeUndefined();
    await service.sweepHints(T0 + 5 * H);
    store().closeInChat(APP, b, store().getItem(APP, b)!.rev, 'local', T0 + 6 * H);
    await service.sweepHints(T0 + 7 * H);
    await service.sweepHints(T0 + 8 * H);
    expect(store().getItem(APP, big)!.hint?.key).toBe(`close:children:${T0 + 6 * H}`);
    expect(hintNotices()).toBe(2);
  });

  it('挂上一个早就结束了的子任务：结束时刻没变，不重复通知', async () => {
    steward = { enabled: true, chatId: 'oc_steward', closeHints: true };
    const big = mk('大任务', {}, T0);
    const a = mk('A', { parentSeq: big }, T0);
    upd(a, { state: 'done' }, T0 + 2 * H);
    const old = mk('早就做完的', {}, T0);
    upd(old, { state: 'done' }, T0 + H);
    await service.sweepHints(T0 + 3 * H);
    upd(old, { parentSeq: big }, T0 + 4 * H);
    await service.sweepHints(T0 + 5 * H);
    expect(store().getItem(APP, big)!.hint?.key).toBe(`close:children:${T0 + 2 * H}`);
    expect(hintNotices()).toBe(1);
  });

  it('「可以收尾」挂着、条件一直成立：补记已完成的子任务、挪走最后结束的那个、完成改关闭都不换 key、不重复通知、不多记历史', async () => {
    steward = { enabled: true, chatId: 'oc_steward', closeHints: true };
    const big = mk('大任务', {}, T0);
    const a = mk('A', { parentSeq: big }, T0);
    const b = mk('B', { parentSeq: big }, T0);
    upd(a, { state: 'done' }, T0 + H);
    upd(b, { state: 'done' }, T0 + 2 * H);
    await service.sweepHints(T0 + 3 * H);
    const key = store().getItem(APP, big)!.hint!.key;
    const hintHistory = () => store().events(APP, big).filter(e => e.kind === 'hint').length;
    expect(hintHistory()).toBe(1);
    mk('补记一个早就做完的', { parentSeq: big, state: 'done' }, T0 + 4 * H);
    await service.sweepHints(T0 + 5 * H);
    upd(b, { parentSeq: null }, T0 + 6 * H);
    await service.sweepHints(T0 + 7 * H);
    upd(a, { state: 'closed' }, T0 + 8 * H);
    await service.sweepHints(T0 + 9 * H);
    expect(store().getItem(APP, big)!.hint?.key).toBe(key);
    expect(hintNotices()).toBe(1);
    expect(hintHistory()).toBe(1);
  });

  it('新建一个没结束的子任务（board add --parent）：上级的「可以收尾」立刻清掉；清掉后原样回来时历史不重复记', async () => {
    steward = { enabled: true, chatId: 'oc_steward', closeHints: true };
    const big = mk('大任务', {}, T0);
    const a = mk('A', { parentSeq: big }, T0);
    upd(a, { state: 'done' }, T0 + H);
    await service.sweepHints(T0 + 2 * H);
    expect(store().getItem(APP, big)!.hint).toBeDefined();
    const open = mk('新的子任务', { parentSeq: big }, T0 + 3 * H);
    expect(store().getItem(APP, big)!.hint).toBeUndefined();
    // 挪走它：条件又成立、结束时刻没变，巡检原样标回来，历史里不再多一句、不再通知。
    upd(open, { parentSeq: null }, T0 + 4 * H);
    await service.sweepHints(T0 + 5 * H);
    expect(store().getItem(APP, big)!.hint?.key).toBe(`close:children:${T0 + H}`);
    expect(store().events(APP, big).filter(e => e.kind === 'hint')).toHaveLength(1);
    expect(hintNotices()).toBe(1);
  });

  it('唯一的子任务挪走后旧上级没有子任务了：它的「可以收尾」立刻清掉；子任务变化不动上级的其它提示', async () => {
    steward = { enabled: true, chatId: 'oc_steward', closeHints: true };
    const big = mk('大任务', {}, T0);
    const other = mk('另一项', {}, T0);
    const a = mk('A', { parentSeq: big }, T0);
    upd(a, { state: 'done' }, T0 + H);
    await service.sweepHints(T0 + 2 * H);
    expect(store().getItem(APP, big)!.hint?.kind).toBe('close');
    upd(a, { parentSeq: other }, T0 + 3 * H);
    expect(store().getItem(APP, big)!.hint).toBeUndefined();
    // 上级挂着「该看一眼」（复查到点没动）：子任务改状态不清它。
    const p2 = mk('有复查的大任务', { nextCheckAt: T0 + 4 * H }, T0 + 3 * H);
    const c2 = mk('子任务', { parentSeq: p2 }, T0 + 3 * H);
    await service.sweepHints(T0 + 5 * H);
    expect(store().getItem(APP, p2)!.hint?.kind).toBe('stale');
    upd(c2, { state: 'waiting' }, T0 + 5.5 * H);
    expect(store().getItem(APP, p2)!.hint?.kind).toBe('stale');
  });

  it('复查约在大任务上：子任务之后有进展不算大任务被看过（总览、CLI、巡检同一口径）；owner 之后提交了决定算', async () => {
    steward = { enabled: true, chatId: 'oc_steward', closeHints: true };
    const big = mk('大任务', { nextCheckAt: T0 + 86_400_000 }, T0);
    const c = mk('子任务', { parentSeq: big }, T0);
    store().appendHistory(APP, c, '子任务推进', {}, T0 + 1.2 * 86_400_000);
    const row = service.list('all', 'owner').items.find(i => i.seq === big)!;
    expect(row.lastActivityAt).toBe(T0 + 1.2 * 86_400_000);
    expect(row.ownActivityAt).toBe(T0);
    expect(boardCheckStatus(row, T0 + 1.5 * 86_400_000)).toBe('due');
    const body = await service.cli({ action: 'list' }, { sessionId: 'sess-1' }) as Record<string, unknown>;
    expect(formatBoardResult('list', body, T0 + 1.5 * 86_400_000).split('\n').find(l => l.includes(`#${big} `))).toContain('⏰过了复查时间');
    await service.sweepHints(T0 + 1.5 * 86_400_000);
    expect(store().getItem(APP, big)!.hint?.kind).toBe('stale');

    const q = mk('要拍板', { question: '定不定？', options: [{ key: 'A', label: '定' }], nextCheckAt: T0 + 86_400_000 }, T0);
    const d = store().putDraft(APP, q, 'owner', { choice: 'A', baseRev: 1 }, T0 + 1.1 * 86_400_000)!;
    store().submit(APP, { author: 'owner', nonce: 'nq', items: [{ seq: q, draftUpdatedAt: d.updatedAt }] }, T0 + 1.2 * 86_400_000);
    const qrow = service.list('all', 'owner').items.find(i => i.seq === q)!;
    expect(boardCheckStatus(qrow, T0 + 1.5 * 86_400_000)).toBe('passed');
    await service.sweepHints(T0 + 1.6 * 86_400_000);
    expect(store().getItem(APP, q)!.hint).toBeUndefined();
  });

  it('大任务自己几天没改、子任务一直在推进：最近进展按子树算，不标很久没动（列表、CLI 一致）', async () => {
    const big = mk('大任务', {}, T0);
    const c = mk('子任务', { parentSeq: big }, T0);
    store().appendHistory(APP, c, '推进了一步', {}, T0 + 3.5 * 86_400_000);
    const row = service.list('all', 'owner').items.find(i => i.seq === big)!;
    expect(row.lastActivityAt).toBe(T0 + 3.5 * 86_400_000);
    expect(service.detail(big, 'owner').lastActivityAt).toBe(T0 + 3.5 * 86_400_000);
    const body = await service.cli({ action: 'list' }, { sessionId: 'sess-1' }) as Record<string, unknown>;
    const out = formatBoardResult('list', body, T0 + 3.6 * 86_400_000);
    expect(out).not.toContain('天没动');
  });

  it('复查时间到点后管家写了进展（没重设复查时间）：CLI 不再写「过了复查时间」；之后又三天没动才写几天没动', async () => {
    const seq = mk('复查', { nextCheckAt: T0 + 86_400_000 }, T0);
    store().appendHistory(APP, seq, '看过了，还在等', {}, T0 + 1.5 * 86_400_000);
    const body = await service.cli({ action: 'list' }, { sessionId: 'sess-1' }) as Record<string, unknown>;
    expect(formatBoardResult('list', body, T0 + 2 * 86_400_000)).not.toContain('⏰');
    expect(formatBoardResult('list', body, T0 + 5 * 86_400_000)).toContain('⏳3 天没动');
    // 约在以后的（暂时搁置）再久没动也不写几天没动；已结束的不写在等谁。
    const parked = mk('搁置', { state: 'waiting', nextCheckAt: T0 + 30 * 86_400_000, waitingOn: '外部团队' }, T0);
    const ended = mk('结束了', { state: 'waiting', waitingOn: 'PR 作者' }, T0);
    store().updateItem(APP, ended, { state: 'done', waitingOn: 'PR 作者' }, 's', T0 + H);
    const body2 = await service.cli({ action: 'list' }, { sessionId: 'sess-1' }) as Record<string, unknown>;
    const lines = formatBoardResult('list', body2, T0 + 20 * 86_400_000).split('\n');
    expect(lines.find(l => l.includes(`#${parked} `))).not.toContain('天没动');
    expect(lines.find(l => l.includes(`#${ended} `))).not.toContain('在等');
  });

  it('「在等谁」跟着等待中走：改成别的状态时自动清掉；同一条命令另写了的照写', async () => {
    const seq = await add('等人', { fields: { state: 'waiting' }, waitingOn: 'PR 作者' });
    await set(seq, { fields: { state: 'active' } });
    expect(store().getItem(APP, seq)!.waitingOn).toBeUndefined();
    expect(store().events(APP, seq).map(e => e.text)).toContain('在等：无');
    await set(seq, { fields: { state: 'decide', question: '要不要换人？' }, waitingOn: '评审群' });
    expect(store().getItem(APP, seq)!.waitingOn).toBe('评审群');
    await set(seq, { fields: { stage: '在审' } });
    expect(store().getItem(APP, seq)!.waitingOn).toBe('评审群');
  });

  it('最近进展：收进历史的草稿不算，owner 提交的决定算；子任务完成情况在筛过的视图里照样按整张看板算', async () => {
    const seq = mk('拍板', { question: '合不合？', options: [{ key: 'A', label: '合' }] }, T0);
    store().putDraft(APP, seq, 'owner', { text: '迟到', baseRev: 1, archive: true }, T0 + H);
    expect(store().events(APP, seq).some(e => e.kind === 'draft')).toBe(true);
    expect(service.list('all', 'owner').items.find(i => i.seq === seq)!.lastActivityAt).toBe(T0);
    const d = store().putDraft(APP, seq, 'owner', { choice: 'A', baseRev: 1 }, T0 + 2 * H)!;
    store().submit(APP, { author: 'owner', nonce: 'n1', items: [{ seq, draftUpdatedAt: d.updatedAt }] }, T0 + 3 * H);
    expect(service.list('all', 'owner').items.find(i => i.seq === seq)!.lastActivityAt).toBe(T0 + 3 * H);

    const big = mk('大任务', {}, T0);
    const done = mk('做完的', { parentSeq: big }, T0);
    upd(done, { state: 'done' }, T0 + H);
    mk('还在做', { parentSeq: big }, T0);
    expect(service.list('active', 'owner').items.find(i => i.seq === big)!.childStats).toEqual({ total: 2, done: 1, closed: 0 });
  });

  it('库里已有坏的父子数据（成环）：只改依赖照样能改；列表、详情、CLI 给的上级都是实际生效的那个', async () => {
    const a = mk('A', {}, T0);
    const b = mk('B', {}, T0);
    const c = mk('C', {}, T0);
    const db = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    db.prepare('UPDATE board_items SET parent_seq = ? WHERE app_id = ? AND seq = ?').run(b, APP, a);
    db.prepare('UPDATE board_items SET parent_seq = ? WHERE app_id = ? AND seq = ?').run(a, APP, b);
    db.close();
    await set(a, { dependsOn: String(c) });
    expect(store().getItem(APP, a)!.dependsOn).toEqual([c]);
    const rows = service.list('all', 'owner').items.filter(i => i.seq === a || i.seq === b);
    // 环断开一处：恰好一项有上级，且和 parent 字段一致。
    expect(rows.filter(r => r.parentSeq !== undefined)).toHaveLength(1);
    for (const r of rows) expect(r.parentSeq).toBe(r.parent?.seq);
    const child = rows.find(r => r.parentSeq !== undefined)!;
    expect(service.detail(child.parentSeq!, 'owner').children.map(x => x.seq)).toEqual([child.seq]);
    expect(service.detail(child.seq, 'owner').children).toEqual([]);
    const body = await service.cli({ action: 'list' }, { sessionId: 'sess-1' }) as { items: Array<{ seq: number; parentSeq?: number }> };
    expect(body.items.filter(i => i.seq === a || i.seq === b).filter(i => i.parentSeq !== undefined)).toHaveLength(1);
  });
});

describe('CLI', () => {
  it('--parent / --waiting-on 给 add、set 原样传；只改它们也算改了字段；riff 远端也认', () => {
    const ok = (argv: string[]) => (parseBoardArgs(argv) as { ok: true; parsed: { request: Record<string, unknown> } }).parsed.request;
    expect(ok(['add', '子任务', '--no-chat', 'r', '--parent', '12', '--waiting-on', 'PR 作者'])).toMatchObject({ parent: '12', waitingOn: 'PR 作者' });
    expect(ok(['set', '3', '--parent', 'none'])).toMatchObject({ ref: '3', parent: 'none' });
    expect(ok(['set', '3', '--waiting-on', 'none'])).toMatchObject({ waitingOn: 'none' });
    expect(parseBoardArgs(['list', '--parent', '3'])).toMatchObject({ ok: false });
    expect(() => riffHostFileArguments(['board', 'set', '3', '--parent', '12', '--waiting-on', 'x'])).not.toThrow();
  });

  it('list 按树缩进；子任务完成情况、在等谁、过了复查时间、很久没动写在行里；上级不在这一页时写属于谁', async () => {
    const big = await add('发 v3.60');
    const a = await add('修启动崩溃', { parent: String(big), fields: { state: 'waiting' }, waitingOn: 'PR 作者' });
    const b = await add('写发布说明', { parent: String(big) });
    await add('补 e2e', { parent: String(b) });
    await set(b, { fields: { state: 'done' } });
    const lone = await add('老任务');
    const due = await add('该再看了', { nextCheck: '+1h' });
    const now = Date.now();
    const body = await service.cli({ action: 'list' }, { sessionId: 'sess-1' }) as Record<string, unknown>;
    const lines = formatBoardResult('list', body, now + 4 * DAY).split('\n').slice(1).map(l => l.replace(/\s+https:\S+/g, ''));
    const line = (seq: number) => lines.find(l => l.includes(`#${seq} `))!;
    expect(lines.findIndex(l => l.includes(`#${a} `))).toBeGreaterThan(lines.findIndex(l => l.includes(`#${big} `)));
    expect(line(big)).toMatch(new RegExp(`^#${big} 进行中 发 v3\\.60  子任务 1/2`));
    expect(line(a)).toMatch(new RegExp(`^└ #${a} 等待中 修启动崩溃  在等：PR 作者`));
    expect(line(b)).toMatch(new RegExp(`^└ #${b} 已完成 写发布说明  子任务 0/1`));
    expect(lines.find(l => l.includes('补 e2e'))).toMatch(/^ {2}└ #\d+ /);
    expect(line(lone)).toContain('⏳4 天没动');
    expect(line(due)).toContain('⏰过了复查时间');
    expect(line(due)).not.toContain('天没动');

    const decide = await service.cli({ action: 'list', view: 'active' }, { sessionId: 'sess-1' }) as Record<string, unknown>;
    const active = formatBoardResult('list', decide, now).split('\n');
    expect(active.find(l => l.includes('补 e2e'))).toMatch(new RegExp(`^#\\d+ 进行中 补 e2e（属于 #${b}）`));
  });
});

describe('存储迁移', () => {
  it('改动前建的库：打开时补上 parent_seq / waiting_on，旧行没有上级、照常显示；版本号不升', () => {
    let store = DecisionBoardStore.open(dir);
    const seq = store.addItem(APP, { title: 'old', noChatReason: 'x' }, undefined, 500).item.seq;
    store.close();
    const db = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    for (const c of ['parent_seq', 'waiting_on']) db.exec(`ALTER TABLE board_items DROP COLUMN ${c};`);
    db.close();
    store = DecisionBoardStore.open(dir);
    expect(store.getItem(APP, seq)).not.toHaveProperty('parentSeq');
    const child = store.addItem(APP, { title: 'new', noChatReason: 'x', parentSeq: seq, waitingOn: '外部' }, undefined, 600).item.seq;
    expect(store.getItem(APP, child)).toMatchObject({ parentSeq: seq, waitingOn: '外部' });
    expect(store.listItems(APP, 'all').find(i => i.seq === seq)!.childStats).toEqual({ total: 1, done: 0, closed: 0 });
    store.close();
    const raw = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    raw.close();
  });
});
