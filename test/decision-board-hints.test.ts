/**
 * 决策看板「自动发现可以关的项」：后台巡检（不调模型）按 PR 合入、依赖结束、复查时间给事项标提示、
 * 记历史，并给管家会话发一条合并的通知。只提示、不改状态；同一条提示只通知一次；没写条件的项不受影响。
 *
 * 用真实的存储和服务，PR 状态和投递是假的，时间用 sweepHints(now) 显式推进。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionBoardService, type DecisionBoardServiceDeps } from '../src/core/decision-board/service.js';
import { composeStewardGuide, normalizeStewardConfig, parseBoardTurnId, stewardGuidePreset, type StewardConfig } from '../src/core/decision-board/model.js';
import {
  evaluateHints,
  formatHintTurnId,
  parseCloseWhenSpec,
  parseDependsOnSpec,
  parseHintTurnId,
  parseNextCheckSpec,
  type PrMergeState,
} from '../src/core/decision-board/hints.js';
import { createPrStateLookup, OPEN_RECHECK_MS } from '../src/core/decision-board/github-pr-state.js';
import { parseBoardArgs } from '../src/cli/board-command.js';
import { riffHostFileArguments } from '../src/services/riff-host-tools.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { DecisionBoardStore, decisionBoardDbPath } from '../src/services/decision-board-store.js';

const APP = 'cli_steward';
const HOUR = 3_600_000;

let dir: string;
let steward: StewardConfig | undefined;
let prStates: Map<string, PrMergeState>;
let prLookups: string[];
let delivered: Array<Parameters<DecisionBoardServiceDeps['deliver']>[0]>;
let deliverImpl: DecisionBoardServiceDeps['deliver'];
let service: DecisionBoardService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-board-hints-'));
  steward = { enabled: true, chatId: 'oc_steward', closeHints: true };
  prStates = new Map();
  prLookups = [];
  delivered = [];
  deliverImpl = async input => { delivered.push(input); return { sessionId: 'sess-steward' }; };
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
    deliver: input => deliverImpl(input),
    log: () => {},
    lookupChat: async chatId => ({ ok: true, chatId, appId: APP, name: `群-${chatId}` }),
    prState: async ref => { prLookups.push(ref); return prStates.get(ref); },
  });
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

async function add(title: string, extra: Record<string, unknown> = {}) {
  const res = await service.cli({ action: 'add', title, noChat: '用例', ...extra }, { sessionId: 'sess-1' }) as { item: { seq: number } };
  return res.item.seq;
}

async function set(seq: number, extra: Record<string, unknown>) {
  return service.cli({ action: 'set', ref: String(seq), ...extra }, { sessionId: 'sess-1' }) as Promise<{ item: Record<string, any> }>;
}

function item(seq: number) {
  return service.store().getItem(APP, seq)!;
}

function hintEvents(seq: number) {
  return service.store().events(APP, seq).filter(e => e.kind === 'hint');
}

describe('巡检提示', () => {
  it('挂了 PR、没写条件：PR 合入后标「建议关闭」、记一条系统历史，状态不变；只通知一次', async () => {
    const seq = await add('修登录', { links: ['pr=o/r#142'] });
    prStates.set('o/r#142', 'open');
    await service.sweepHints(Date.now());
    expect(item(seq).hint).toBeUndefined();
    expect(delivered).toHaveLength(0);

    prStates.set('o/r#142', 'merged');
    const res = await service.sweepHints(Date.now());
    expect(res).toMatchObject({ marked: 1, notified: 1 });
    expect(item(seq)).toMatchObject({ state: 'active', hint: { kind: 'close', key: 'close:pr:o/r#142' } });
    expect(hintEvents(seq)).toEqual([expect.objectContaining({ actor: 'system', text: '建议关闭：PR o/r#142 已合入' })]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.turnId).toMatch(new RegExp(`^board:${APP}:hint-\\d+(?:-\\d+)?$`));
    expect(delivered[0]!.prompt).toContain('#1 修登录 — 建议关闭：PR o/r#142 已合入');
    expect(delivered[0]!.prompt).toContain('--dismiss-hint');
    expect(delivered[0]!.announcement.texts.join('')).toContain('【决策看板 · 提示】');
    expect(delivered[0]!.chatId).toBe('oc_steward');
    // 系统提示不冒充 owner：无身份投递。
    expect(delivered[0]).not.toHaveProperty('ownerOpenId');

    // 下一轮：提示还在，不再记历史、不再通知。
    await service.sweepHints(Date.now());
    await service.sweepHints(Date.now());
    expect(delivered).toHaveLength(1);
    expect(hintEvents(seq)).toHaveLength(1);
  });

  it('挂了几个 PR：全部合入才建议关闭；有没合就关掉的建议推进', async () => {
    const seq = await add('两个 PR', { links: ['pr=o/r#1', 'pr=o/r#2'] });
    prStates.set('o/r#1', 'merged');
    prStates.set('o/r#2', 'open');
    await service.sweepHints(Date.now());
    expect(item(seq).hint).toBeUndefined();
    prStates.set('o/r#2', 'closed');
    await service.sweepHints(Date.now());
    expect(item(seq).hint).toMatchObject({ kind: 'advance', key: 'advance:pr-closed:o/r#2' });
  });

  it('依赖的项都完成后标「建议推进」；还有没完成的不标', async () => {
    const a = await add('#66 前置');
    const b = await add('#70 前置');
    const seq = await add('等前置', { dependsOn: `${a},${b}`, fields: { state: 'waiting' } });
    expect(item(seq).dependsOn).toEqual([a, b]);
    await set(a, { fields: { state: 'done' } });
    await service.sweepHints(Date.now());
    expect(item(seq).hint).toBeUndefined();
    await set(b, { fields: { state: 'done' } });
    await service.sweepHints(Date.now());
    expect(item(seq)).toMatchObject({ state: 'waiting', hint: { kind: 'advance', key: `advance:deps:${a},${b}` } });
    expect(delivered.at(-1)!.prompt).toContain(`建议推进：依赖的 #${a}、#${b} 都已完成`);
  });

  it('--close-when "item:<n> done"：那一项完成后建议关闭；manual 让挂了 PR 的项也不按 PR 判断', async () => {
    const dep = await add('被等的');
    const seq = await add('跟着收', { closeWhen: `item:${dep} done` });
    const manual = await add('只由管家判断', { links: ['pr=o/r#9'], closeWhen: 'manual' });
    prStates.set('o/r#9', 'merged');
    await set(dep, { fields: { state: 'done' } });
    await service.sweepHints(Date.now());
    expect(item(seq).hint).toMatchObject({ kind: 'close', key: `close:item:${dep}` });
    expect(item(manual).hint).toBeUndefined();
    expect(prLookups).not.toContain('o/r#9');
  });

  it('没写任何条件的项不受影响：没有提示、没有历史、updated_at 不变、不查 PR、不发通知', async () => {
    const seq = await add('普通事项', { links: ['issue=o/r#5', 'url=https://example.com'] });
    const before = item(seq);
    const events = service.store().events(APP, seq).length;
    await service.sweepHints(Date.now() + 365 * 24 * HOUR);
    expect(item(seq)).toEqual(before);
    expect(service.store().events(APP, seq)).toHaveLength(events);
    expect(prLookups).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it('过了复查时间还没动：标「该看一眼」；管家一更新就清掉；新的复查时间到了再标一次', async () => {
    const t0 = Date.now();
    const seq = await add('等人回', { nextCheck: '+2h' });
    expect(item(seq).nextCheckAt).toBeGreaterThanOrEqual(t0 + 2 * HOUR);
    await service.sweepHints(t0 + HOUR);
    expect(item(seq).hint).toBeUndefined();
    await service.sweepHints(t0 + 3 * HOUR);
    expect(item(seq).hint).toMatchObject({ kind: 'stale' });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.prompt).toContain('该看一眼：过了复查时间还没有更新');

    // 管家记一句历史 = 动过了。
    service.store().appendHistory(APP, seq, '问过了，等回复', {}, t0 + 3.5 * HOUR);
    expect(item(seq).hint).toBeUndefined();
    // 那之后巡检也不再标（updated_at 已晚于复查时间）。
    await service.sweepHints(t0 + 4 * HOUR);
    expect(item(seq).hint).toBeUndefined();

    // 重设复查时间：新的时间到了再标、再通知一次（key 带复查时间）。
    await set(seq, { nextCheck: '+1h' });
    await service.sweepHints(Date.now() + 2 * HOUR);
    expect(item(seq).hint).toMatchObject({ kind: 'stale' });
    expect(delivered).toHaveLength(2);

    // 管家改了别的字段（不改状态）：也算动过，「该看一眼」立刻收起，不等下一轮。
    await set(seq, { fields: { progress: '已催' } });
    expect(item(seq).hint).toBeUndefined();
  });

  it('同一轮多项合成一条通知；一轮最多一条', async () => {
    const a = await add('A', { links: ['pr=o/r#1'] });
    const b = await add('B', { links: ['pr=o/r#2'] });
    prStates.set('o/r#1', 'merged');
    prStates.set('o/r#2', 'merged');
    const res = await service.sweepHints(Date.now());
    expect(res?.notified).toBe(2);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.prompt).toContain(`#${a} A`);
    expect(delivered[0]!.prompt).toContain(`#${b} B`);
  });

  it('提示只提示：管家改状态后收起，同一条不再出现；已结束的项清掉提示', async () => {
    const seq = await add('修登录', { links: ['pr=o/r#1'] });
    prStates.set('o/r#1', 'merged');
    await service.sweepHints(Date.now());
    await set(seq, { fields: { state: 'accept' } });
    expect(item(seq).hint).toBeUndefined();
    await service.sweepHints(Date.now());
    expect(item(seq).hint).toBeUndefined();
    expect(delivered).toHaveLength(1);

    const other = await add('另一个', { links: ['pr=o/r#2'] });
    prStates.set('o/r#2', 'merged');
    await service.sweepHints(Date.now());
    // 绕过 CLI 直接把它关掉（模拟旧构建 / 别的写入方）：下一轮巡检清掉提示。
    const db = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    db.prepare(`UPDATE board_items SET state = 'done' WHERE app_id = ? AND seq = ?`).run(APP, other);
    db.close();
    await service.sweepHints(Date.now());
    expect(item(other).hint).toBeUndefined();
  });

  it('--dismiss-hint 收起并记一句；同一条不再出现，但更高优先级的新提示照样出现', async () => {
    const dep = await add('前置');
    const seq = await add('后续', { links: ['pr=o/r#3'], dependsOn: String(dep) });
    await set(dep, { fields: { state: 'done' } });
    prStates.set('o/r#3', 'open');
    await service.sweepHints(Date.now());
    expect(item(seq).hint).toMatchObject({ kind: 'advance' });
    await set(seq, { dismissHint: true });
    expect(item(seq).hint).toBeUndefined();
    expect(service.store().events(APP, seq).find(e => e.kind === 'hint' && e.actor === 'steward')?.text).toMatch(/^收起提示：建议推进/);
    await service.sweepHints(Date.now());
    expect(item(seq).hint).toBeUndefined();
    prStates.set('o/r#3', 'merged');
    await service.sweepHints(Date.now());
    expect(item(seq).hint).toMatchObject({ kind: 'close' });
  });

  it('PR 这轮查不到：保留现有提示，不清也不换', async () => {
    const seq = await add('修登录', { links: ['pr=o/r#1'] });
    prStates.set('o/r#1', 'merged');
    await service.sweepHints(Date.now());
    prStates.delete('o/r#1');
    await service.sweepHints(Date.now());
    expect(item(seq).hint).toMatchObject({ kind: 'close' });
    // 从没查到过的不下结论。
    const other = await add('查不到', { links: ['pr=o/r#404'] });
    await service.sweepHints(Date.now());
    expect(item(other).hint).toBeUndefined();
  });

  it('投递抛错（管家会话在开场等）：不记已通知，下一轮重试；成功后不再发', async () => {
    const seq = await add('修登录', { links: ['pr=o/r#1'] });
    prStates.set('o/r#1', 'merged');
    deliverImpl = async () => { throw new Error('steward session sess-x is in pending_repo'); };
    expect((await service.sweepHints(Date.now()))?.notified).toBe(0);
    expect(item(seq).hint).toMatchObject({ kind: 'close' });
    deliverImpl = async input => { delivered.push(input); return { sessionId: 's' }; };
    expect((await service.sweepHints(Date.now()))?.notified).toBe(1);
    await service.sweepHints(Date.now());
    expect(delivered).toHaveLength(1);
    expect(hintEvents(seq)).toHaveLength(1);
  });

  it('送进 worker 后的失败回执：入队前被拒才重发；结果未知（收据超时）不重发', async () => {
    await add('修登录', { links: ['pr=o/r#1'] });
    prStates.set('o/r#1', 'merged');
    await service.sweepHints(Date.now());
    expect(delivered).toHaveLength(1);
    service.noteDeliveryFailure(delivered[0]!.turnId, 'receipt_timeout', 'worker.input_delivery_failed');
    await service.sweepHints(Date.now());
    await service.sweepHints(Date.now());
    expect(delivered).toHaveLength(1);

    await add('另一个', { links: ['pr=o/r#2'] });
    prStates.set('o/r#2', 'merged');
    await service.sweepHints(Date.now());
    expect(delivered).toHaveLength(2);
    service.noteDeliveryFailure(delivered[1]!.turnId, 'worker_rejected:busy', 'worker.input_rejected_before_admission');
    await service.sweepHints(Date.now());
    expect(delivered).toHaveLength(3);
    expect(delivered[2]!.turnId).not.toBe(delivered[1]!.turnId);
    expect(delivered[2]!.prompt).toContain('另一个');
    expect(delivered[2]!.prompt).not.toContain('修登录');
    // 提示回合 id 不会被当成批次号解析。
    expect(parseBoardTurnId(delivered[0]!.turnId)).toBeNull();
  });

  it('同毫秒两次 sweep 或提示通知生成的回合 turnId 互不相同（防撞 id）', async () => {
    // 用未来时间：sweepHints 内 at = max(now, Date.now())，过去的注入值会被真实时钟顶掉，
    // 两次 sweep 落到不同毫秒，同毫秒防撞 id 的后半段断言就不再咬回归。
    const fixedNow = Date.now() + HOUR;
    const id1 = formatHintTurnId('app_test', fixedNow);
    const id2 = formatHintTurnId('app_test', fixedNow);
    expect(id1).not.toBe(id2);
    expect(parseHintTurnId(id1)).toMatchObject({ appId: 'app_test', round: fixedNow });
    expect(parseHintTurnId(id2)).toMatchObject({ appId: 'app_test', round: fixedNow });

    await add('任务1', { links: ['pr=o/r#101'] });
    prStates.set('o/r#101', 'merged');
    await service.sweepHints(fixedNow);
    service.noteDeliveryFailure(delivered.at(-1)!.turnId, 'worker_rejected:busy', 'worker.input_rejected_before_admission');
    await service.sweepHints(fixedNow);
    const lastTwo = delivered.slice(-2);
    expect(lastTwo[1]!.turnId).not.toBe(lastTwo[0]!.turnId);
  });

  it('投递一直抛错（可能已发出横幅）：同一条提示最多自动投 3 次', async () => {
    await add('修登录', { links: ['pr=o/r#1'] });
    prStates.set('o/r#1', 'merged');
    let attempts = 0;
    deliverImpl = async () => { attempts++; throw new Error('banner posted, then session gone'); };
    for (let i = 0; i < 6; i++) await service.sweepHints(Date.now());
    expect(attempts).toBe(3);
  });

  it('投递卡住不返回：之后的巡检照常给看板标提示，只是不叠发通知', async () => {
    await add('A', { links: ['pr=o/r#1'] });
    prStates.set('o/r#1', 'merged');
    let release!: () => void;
    deliverImpl = input => { delivered.push(input); return new Promise(resolve => { release = () => resolve({ sessionId: 's' }); }); };
    const first = service.sweepHints(Date.now());
    for (let i = 0; i < 100 && !delivered.length; i++) await new Promise(r => setTimeout(r, 5));
    expect(delivered).toHaveLength(1);
    const b = await add('B', { links: ['pr=o/r#2'] });
    prStates.set('o/r#2', 'merged');
    await service.sweepHints(Date.now());
    expect(item(b).hint).toMatchObject({ kind: 'close' });
    expect(delivered).toHaveLength(1);
    release();
    await first;
    deliverImpl = async input => { delivered.push(input); return { sessionId: 's' }; };
    await service.sweepHints(Date.now());
    expect(delivered).toHaveLength(2);
    expect(delivered[1]!.prompt).toContain('#2 B');
  });

  it('PR 查不到时只保留靠 PR 得出的提示：依赖重开了照样清掉', async () => {
    const dep = await add('前置');
    const seq = await add('后续', { dependsOn: String(dep), links: ['pr=corp/internal#7'] });
    await set(dep, { fields: { state: 'done' } });
    await service.sweepHints(Date.now());
    expect(item(seq).hint).toMatchObject({ kind: 'advance', key: `advance:deps:${dep}` });
    await set(dep, { fields: { state: 'active' } });
    await service.sweepHints(Date.now());
    expect(item(seq).hint).toBeUndefined();
  });

  it('改关闭条件 / 依赖：原来的提示立刻清掉（不算收起），按新条件重算', async () => {
    const seq = await add('修登录', { links: ['pr=o/r#1'] });
    prStates.set('o/r#1', 'merged');
    await service.sweepHints(Date.now());
    const res = await set(seq, { closeWhen: 'pr:o/r#2 merged' });
    expect(res.item).not.toHaveProperty('hint');
    prStates.set('o/r#2', 'open');
    await service.sweepHints(Date.now());
    expect(item(seq).hint).toBeUndefined();
    // 换回原来的条件：原提示没被收起，照样回来。
    await set(seq, { closeWhen: 'auto' });
    await service.sweepHints(Date.now());
    expect(item(seq).hint).toMatchObject({ key: 'close:pr:o/r#1' });
  });

  it('PR 超过一轮的查询上限：轮转着查，排在后面的 PR 合入后几轮内也出提示', async () => {
    const seqs: number[] = [];
    for (let i = 1; i <= 45; i++) seqs.push(await add(`事项 ${i}`, { links: [`pr=o/r#${i}`] }));
    for (let i = 1; i <= 45; i++) prStates.set(`o/r#${i}`, 'open');
    prStates.set('o/r#45', 'merged');
    for (let round = 0; round < 3 && !item(seqs[44]!).hint; round++) await service.sweepHints(Date.now());
    expect(item(seqs[44]!).hint).toMatchObject({ kind: 'close', key: 'close:pr:o/r#45' });
  });

  it('开关关着 / 管家没选群：不跑；关掉后已有的提示不往外带', async () => {
    const seq = await add('修登录', { links: ['pr=o/r#1'] });
    prStates.set('o/r#1', 'merged');
    steward = { enabled: true, chatId: 'oc_steward' };
    expect(await service.sweepHints(Date.now())).toBeUndefined();
    expect(prLookups).toEqual([]);
    steward = { enabled: true, closeHints: true };
    expect(await service.sweepHints(Date.now())).toBeUndefined();

    steward = { enabled: true, chatId: 'oc_steward', closeHints: true };
    await service.sweepHints(Date.now());
    const shown = await service.cli({ action: 'show', ref: String(seq) }, { sessionId: 's' }) as { item: Record<string, unknown> };
    expect(shown.item.hint).toMatchObject({ kind: 'close' });
    steward = { enabled: true, chatId: 'oc_steward' };
    const hidden = await service.cli({ action: 'show', ref: String(seq) }, { sessionId: 's' }) as { item: Record<string, unknown> };
    expect(hidden.item).not.toHaveProperty('hint');
    expect(service.list('all', 'owner').items[0]).not.toHaveProperty('hint');
    expect(service.detail(seq, 'owner').item).not.toHaveProperty('hint');
  });

  it('没用过看板的 bot：巡检不建库', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'decision-board-hints-fresh-'));
    const svc = new DecisionBoardService({
      dataDir: fresh, larkAppId: () => APP, steward: () => ({ enabled: true, chatId: 'oc_x', closeHints: true }),
      locale: () => 'zh', brand: () => 'feishu', dashboardOrigin: () => undefined, ownerOpenId: () => undefined,
      ownerName: async () => undefined, timeZone: () => undefined, batchAttachmentsDir: () => fresh,
      banner: () => '', deliver: async () => ({ sessionId: 's' }), log: () => {},
      lookupChat: async chatId => ({ ok: true, chatId, appId: APP }),
    });
    expect(await svc.sweepHints()).toBeUndefined();
    expect(existsSync(decisionBoardDbPath(fresh))).toBe(false);
    svc.close();
    rmSync(fresh, { recursive: true, force: true });
  });
});

describe('写条件', () => {
  it('依赖 / 关闭条件里的编号必须存在、不能是自己；auto 去掉显式条件；none 清空', async () => {
    const seq = await add('事项');
    await expect(set(seq, { dependsOn: '999' })).rejects.toMatchObject({ code: 'item_not_found' });
    await expect(set(seq, { dependsOn: String(seq) })).rejects.toMatchObject({ code: 'self_reference' });
    await expect(set(seq, { closeWhen: `item:${seq} done` })).rejects.toMatchObject({ code: 'self_reference' });
    await expect(add('新的', { dependsOn: '999' })).rejects.toMatchObject({ code: 'item_not_found' });
    await expect(set(seq, { closeWhen: 'pr merged' })).rejects.toMatchObject({ code: 'invalid_close_when' });
    await expect(set(seq, { nextCheck: '明天' })).rejects.toMatchObject({ code: 'invalid_next_check' });

    await set(seq, { closeWhen: 'pr:o/r#12 merged', nextCheck: '2030-01-02T03:04+08:00' });
    expect(item(seq)).toMatchObject({ closeWhen: { kind: 'pr', ref: 'o/r#12' }, nextCheckAt: Date.parse('2030-01-02T03:04+08:00') });
    expect(service.store().events(APP, seq)[0]!.text).toBe('关闭条件：pr:o/r#12 merged；复查时间：2030-01-01T19:04:00.000Z');
    await set(seq, { closeWhen: 'auto', nextCheck: 'none' });
    expect(item(seq)).not.toHaveProperty('closeWhen');
    expect(item(seq)).not.toHaveProperty('nextCheckAt');
    const other = await add('另一个');
    await set(seq, { dependsOn: `#${other}` });
    expect(item(seq).dependsOn).toEqual([other]);
    await set(seq, { dependsOn: 'none' });
    expect(item(seq)).not.toHaveProperty('dependsOn');
  });

  it('写条件不改待拍板内容的 rev', async () => {
    const seq = await add('问题', { fields: { question: '定不定？' }, options: ['A=定'] });
    const rev = item(seq).rev;
    await set(seq, { closeWhen: 'manual', nextCheck: '+1d' });
    expect(item(seq).rev).toBe(rev);
  });
});

describe('存储迁移', () => {
  it('改动前建的库：打开时补上六列，旧行没有条件也没有提示；版本号不升', () => {
    let store = DecisionBoardStore.open(dir);
    const seq = store.addItem(APP, { title: 'old', noChatReason: 'x' }, undefined, 500).item.seq;
    store.close();
    const db = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    for (const c of ['close_when', 'depends_on', 'next_check_at', 'hint_json', 'hint_notified', 'hint_dismissed']) {
      db.exec(`ALTER TABLE board_items DROP COLUMN ${c};`);
    }
    db.close();
    store = DecisionBoardStore.open(dir);
    const old = store.getItem(APP, seq)!;
    for (const key of ['closeWhen', 'dependsOn', 'nextCheckAt', 'hint']) expect(old).not.toHaveProperty(key);
    store.updateItem(APP, seq, { nextCheckAt: 1_000 }, undefined, 600);
    expect(store.getItem(APP, seq)!.nextCheckAt).toBe(1_000);
    store.close();
    const raw = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    raw.close();
  });
});

describe('解析', () => {
  it('--close-when / --depends-on / --next-check', () => {
    expect(parseCloseWhenSpec('pr:owner/repo#12 merged')).toEqual({ kind: 'pr', ref: 'owner/repo#12' });
    expect(parseCloseWhenSpec('PR=owner/repo#12   merged')).toEqual({ kind: 'pr', ref: 'owner/repo#12' });
    expect(parseCloseWhenSpec('item:#66 done')).toEqual({ kind: 'item', seq: 66 });
    expect(parseCloseWhenSpec('manual')).toEqual({ kind: 'manual' });
    expect(parseCloseWhenSpec('auto')).toBe('auto');
    expect(parseCloseWhenSpec('pr:repo#12 merged')).toHaveProperty('error');
    expect(parseCloseWhenSpec('item:66 closed')).toHaveProperty('error');
    expect(parseDependsOnSpec('66, #70 70，71')).toEqual([66, 70, 71]);
    expect(parseDependsOnSpec('none')).toEqual([]);
    expect(parseDependsOnSpec('66,abc')).toHaveProperty('error');
    expect(parseNextCheckSpec('+2h', 1_000)).toBe(1_000 + 2 * HOUR);
    expect(parseNextCheckSpec('+1w', 0)).toBe(7 * 24 * HOUR);
    expect(parseNextCheckSpec('none', 0)).toBeNull();
    expect(parseNextCheckSpec('2026-11-10T09:30Z', 0)).toBe(Date.parse('2026-11-10T09:30Z'));
    // 已经过去的时间写进去永远不会触发，拒掉。
    expect(parseNextCheckSpec('2026-11-10T09:30Z', Date.parse('2026-11-11T00:00Z'))).toHaveProperty('error');
    expect(parseDependsOnSpec('0')).toHaveProperty('error');
    // 不带时区的时间不收：daemon 和管家可能不在同一时区。
    expect(parseNextCheckSpec('2026-11-10T09:30', 0)).toHaveProperty('error');
    expect(parseNextCheckSpec('2026-11-10', 0)).toHaveProperty('error');
  });

  it('CLI：add / set 都能写条件；--dismiss-hint 只给 set；单改条件也算改了字段', () => {
    const add = parseBoardArgs(['add', 't', '--no-chat', 'x', '--close-when', 'item:3 done', '--depends-on', '1,2', '--next-check', '+3d']);
    expect(add).toMatchObject({ ok: true, parsed: { request: { closeWhen: 'item:3 done', dependsOn: '1,2', nextCheck: '+3d' } } });
    expect(parseBoardArgs(['set', '5', '--dismiss-hint'])).toMatchObject({ ok: true, parsed: { request: { dismissHint: true } } });
    expect(parseBoardArgs(['set', '5', '--next-check', 'none'])).toMatchObject({ ok: true });
    expect(parseBoardArgs(['add', 't', '--no-chat', 'x', '--dismiss-hint'])).toMatchObject({ ok: false });
    expect(parseBoardArgs(['list', '--dismiss-hint'])).toMatchObject({ ok: false });
    // Riff 沙箱里的管家走宿主工具网关：新参数（通知里叫它跑的 --dismiss-hint）要放行。
    expect(() => riffHostFileArguments(['board', 'set', '5', '--dismiss-hint', '--close-when', 'manual', '--depends-on', '1,2', '--next-check', '+2d'])).not.toThrow();
  });

  it('evaluateHints：已结束的项不给提示；依赖里有不存在的编号不下结论', () => {
    const facts = { now: 10, locale: 'zh' as const, prState: () => 'merged' as const, itemState: (s: number) => (s === 1 ? 'done' as const : undefined) };
    expect(evaluateHints({ seq: 9, state: 'done', updatedAt: 0 }, [{ kind: 'pr', ref: 'o/r#1' }], facts).candidates).toEqual([]);
    expect(evaluateHints({ seq: 9, state: 'active', updatedAt: 0, dependsOn: [1, 2] }, [], facts).candidates).toEqual([]);
    expect(evaluateHints({ seq: 9, state: 'active', updatedAt: 0, dependsOn: [1] }, [], facts).candidates.map(c => c.kind)).toEqual(['advance']);
  });
});

describe('规则与配置', () => {
  it('没开 closeHints：guide 与之前逐字相同；开了才多出写条件和「收到提示」两处', () => {
    const off: StewardConfig = { enabled: true, chatId: 'oc_x' };
    const on: StewardConfig = { ...off, closeHints: true };
    for (const locale of ['zh', 'en'] as const) {
      expect(stewardGuidePreset(locale, off)).toBe(stewardGuidePreset(locale));
      expect(composeStewardGuide(off, locale)).toBe(stewardGuidePreset(locale));
      const guide = composeStewardGuide(on, locale);
      expect(guide).toContain('--close-when');
      expect(guide).toContain('--dismiss-hint');
      expect(guide.length).toBeGreaterThan(stewardGuidePreset(locale).length);
      // 插入后原有内容一字不少。
      for (const line of stewardGuidePreset(locale).split('\n')) expect(guide).toContain(line);
    }
  });

  it('closeHints：只认布尔；默认关，关着不写盘', () => {
    expect(normalizeStewardConfig({ enabled: true, closeHints: true })).toEqual({ ok: true, value: { enabled: true, closeHints: true } });
    expect(normalizeStewardConfig({ enabled: true, closeHints: false })).toEqual({ ok: true, value: { enabled: true } });
    expect(normalizeStewardConfig({ enabled: false, closeHints: false })).toEqual({ ok: true, value: null });
    expect(normalizeStewardConfig({ enabled: true, closeHints: 'yes' })).toMatchObject({ ok: false });
  });
});

describe('PR 状态查询', () => {
  function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const impl = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      const r = responses.shift() ?? { status: 500 };
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('合入是终态只查一次；开着的隔一段时间再查并带 ETag；304 沿用；查不到给 undefined', async () => {
    let now = 0;
    const { impl, calls } = fakeFetch([
      { status: 200, body: { state: 'open', merged: false }, headers: { etag: '"e1"' } },
      { status: 304 },
      { status: 200, body: { state: 'closed', merged: true } },
      { status: 404 },
    ]);
    const lookup = createPrStateLookup({ fetchImpl: impl, now: () => now, authHeaders: () => ({ Authorization: 'Bearer t' }) });
    expect(await lookup('o/r#1')).toBe('open');
    expect(calls[0]!.url).toBe('https://api.github.com/repos/o/r/pulls/1');
    expect(calls[0]!.headers.Authorization).toBe('Bearer t');
    expect(await lookup('o/r#1')).toBe('open');
    expect(calls).toHaveLength(1);
    now += OPEN_RECHECK_MS;
    expect(await lookup('o/r#1')).toBe('open');
    expect(calls[1]!.headers['If-None-Match']).toBe('"e1"');
    now += OPEN_RECHECK_MS;
    expect(await lookup('o/r#1')).toBe('merged');
    now += 10 * OPEN_RECHECK_MS;
    expect(await lookup('o/r#1')).toBe('merged');
    expect(calls).toHaveLength(3);
    expect(await lookup('o/r#404')).toBeUndefined();
    expect(await lookup('not a ref')).toBeUndefined();
  });

  it('关掉的 PR 不是终态：重开再合入后照样查到；查不到的隔一阵再试', async () => {
    let now = 0;
    const { impl, calls } = fakeFetch([
      { status: 200, body: { state: 'closed', merged: false } },
      { status: 200, body: { state: 'open', merged: false } },
      { status: 200, body: { state: 'closed', merged: true } },
      { status: 404 },
      { status: 200, body: { state: 'open' } },
    ]);
    const lookup = createPrStateLookup({ fetchImpl: impl, now: () => now, authHeaders: () => ({ Authorization: 'Bearer t' }) });
    expect(await lookup('o/r#9')).toBe('closed');
    now += OPEN_RECHECK_MS;
    expect(await lookup('o/r#9')).toBe('open');
    now += OPEN_RECHECK_MS;
    expect(await lookup('o/r#9')).toBe('merged');
    expect(await lookup('o/r#404')).toBeUndefined();
    expect(await lookup('o/r#404')).toBeUndefined();
    expect(calls).toHaveLength(4);
    now += OPEN_RECHECK_MS;
    expect(await lookup('o/r#404')).toBe('open');
  });

  it('二级频控（403 + retry-after）也暂停请求', async () => {
    let now = 5_000_000;
    const { impl, calls } = fakeFetch([
      { status: 403, headers: { 'x-ratelimit-remaining': '4000', 'retry-after': '60' } },
      { status: 200, body: { state: 'open' } },
    ]);
    const lookup = createPrStateLookup({ fetchImpl: impl, now: () => now, authHeaders: () => ({ Authorization: 'Bearer t' }) });
    expect(await lookup('o/r#1')).toBeUndefined();
    expect(await lookup('o/r#2')).toBeUndefined();
    expect(calls).toHaveLength(1);
    now += 61_000;
    expect(await lookup('o/r#2')).toBe('open');
  });

  it('没有环境 token 时用 gh 的 token；频控后到重置时间前不再请求', async () => {
    let now = 1_000_000;
    const { impl, calls } = fakeFetch([
      { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 60_000) / 1000) } },
      { status: 200, body: { state: 'closed', merged: false } },
    ]);
    const lookup = createPrStateLookup({ fetchImpl: impl, now: () => now, authHeaders: () => ({}), ghToken: async () => 'gh-tok' });
    expect(await lookup('o/r#2')).toBeUndefined();
    expect(calls[0]!.headers.Authorization).toBe('Bearer gh-tok');
    expect(await lookup('o/r#2')).toBeUndefined();
    expect(calls).toHaveLength(1);
    now += 61_000;
    expect(await lookup('o/r#2')).toBe('closed');
  });
});
