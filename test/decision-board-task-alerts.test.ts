/**
 * 决策看板「子任务提醒」：关联群里一轮交付 / 举手 / 中断后防抖核对，合成一条发给管家会话；
 * 同一个结果只提醒一次，管家更新过这一项就不提醒；只提示，不改事项状态。
 *
 * 用真实的存储和服务，会话事实和投递是假的，时间用假定时器推进。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionBoardService, TASK_ALERT_DEBOUNCE_MS, type DecisionBoardServiceDeps } from '../src/core/decision-board/service.js';
import { normalizeStewardConfig, stewardGuidePreset, stewardTaskHintsOn, type StewardConfig } from '../src/core/decision-board/model.js';
import type { ChatSessionRef } from '../src/core/decision-board/chat-task-reader.js';
import type { SessionTaskFacts } from '../src/core/session-task-status.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { DecisionBoardStore, decisionBoardDbPath } from '../src/services/decision-board-store.js';

const APP = 'cli_steward';
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const MIN = 60_000;

let dir: string;
let steward: StewardConfig | undefined;
let sessions: Map<string, ChatSessionRef[]>;
let rows: Map<string, SessionTaskFacts>;
let delivered: Array<Parameters<DecisionBoardServiceDeps['deliver']>[0]>;
let deliverImpl: DecisionBoardServiceDeps['deliver'];
let service: DecisionBoardService;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  dir = mkdtempSync(join(tmpdir(), 'decision-board-task-'));
  steward = { enabled: true, chatId: 'oc_steward', taskHints: true };
  sessions = new Map();
  rows = new Map();
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
    chatTasks: {
      ownAppId: () => APP,
      chatSessions: ids => new Map(ids.map(id => [id, sessions.get(id) ?? []])),
      ownRow: id => rows.get(id),
      peerRow: async () => undefined,
    },
  });
});

afterEach(() => {
  service.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

async function add(title: string, chat: string) {
  const res = await service.cli({ action: 'add', title, links: [`chat=${chat}`] }, { sessionId: 'sess-steward' }) as { item: { seq: number } };
  return res.item.seq;
}

/** 群里一个会话刚交付了一轮（或中断）。 */
function turnEnded(chat: string, session: string, turnId: string, outcome: 'delivered' | 'interrupted' = 'delivered', summary = '修好了') {
  const at = Date.now();
  sessions.set(chat, [{ sessionId: session, larkAppId: APP, status: 'active' }]);
  rows.set(session, {
    status: 'idle', lastMessageAt: at - MIN,
    lastTurn: { turnId, outcome, at, ...(outcome === 'delivered' ? { summary } : { errorCode: 'api_error' }) },
  });
  service.noteTaskEvent(chat);
}

async function elapse(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('子任务提醒', () => {
  it('防抖：两分钟内的几个群的结果合成一条；事项状态不变', async () => {
    const a = await add('修登录', 'oc_a');
    const b = await add('改文档', 'oc_b');
    const before = service.store().getItem(APP, a)!;
    await elapse(MIN);
    turnEnded('oc_a', 's-a', 't-a');
    await elapse(TASK_ALERT_DEBOUNCE_MS - 1_000);
    turnEnded('oc_b', 's-b', 't-b', 'interrupted');
    expect(delivered).toHaveLength(0);
    await elapse(1_000);
    expect(delivered).toHaveLength(1);
    const prompt = delivered[0]!.prompt;
    expect(prompt).toContain(`#${a} 修登录 — 子任务已交付`);
    expect(prompt).toContain('修好了');
    expect(prompt).toContain(`#${b} 改文档 — 子任务中断`);
    expect(delivered[0]!.announcement.texts.join('')).toContain('【决策看板 · 子任务】');
    expect(delivered[0]!.chatId).toBe('oc_steward');
    expect(delivered[0]!.turnId).toMatch(new RegExp(`^board:${APP}:hint-`));
    const after = service.store().getItem(APP, a)!;
    expect({ state: after.state, rev: after.rev, updatedAt: after.updatedAt, stewardEventAt: after.stewardEventAt })
      .toEqual({ state: before.state, rev: before.rev, updatedAt: before.updatedAt, stewardEventAt: before.stewardEventAt });
    // 一分钟后不再有第二条（只有一次定时）。
    await elapse(TASK_ALERT_DEBOUNCE_MS * 2);
    expect(delivered).toHaveLength(1);
  });

  it('同一个结果只提醒一次；同一会话的下一轮再提醒', async () => {
    await add('修登录', 'oc_a');
    await elapse(MIN);
    turnEnded('oc_a', 's-a', 't-1');
    await elapse(TASK_ALERT_DEBOUNCE_MS);
    expect(delivered).toHaveLength(1);
    service.noteTaskEvent('oc_a');
    await elapse(TASK_ALERT_DEBOUNCE_MS);
    expect(delivered).toHaveLength(1);
    turnEnded('oc_a', 's-a', 't-2', 'delivered', '第二轮也好了');
    await elapse(TASK_ALERT_DEBOUNCE_MS);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]!.prompt).toContain('第二轮也好了');
  });

  it('管家在结果之后更新过这一项：不提醒；之后的新结果照样提醒', async () => {
    const a = await add('修登录', 'oc_a');
    await elapse(MIN);
    turnEnded('oc_a', 's-a', 't-1');
    await elapse(MIN);
    await service.cli({ action: 'set', ref: String(a), fields: { stage: '已看过群里的结果' } }, { sessionId: 'sess-steward' });
    expect(service.store().getItem(APP, a)!.updatedAt).toBe(Date.now());
    await elapse(TASK_ALERT_DEBOUNCE_MS);
    expect(delivered).toHaveLength(0);
    turnEnded('oc_a', 's-a', 't-2');
    await elapse(TASK_ALERT_DEBOUNCE_MS);
    expect(delivered).toHaveLength(1);
  });

  it('建项之前就有的结果不提醒；管家群、已结束的项、没关联的群都不提醒', async () => {
    turnEnded('oc_a', 's-a', 't-old');
    await elapse(MIN);
    await add('修登录', 'oc_a');
    const done = await add('早就结了', 'oc_c');
    await service.cli({ action: 'set', ref: String(done), fields: { state: 'done' } }, { sessionId: 'sess-steward' });
    await elapse(MIN);
    service.noteTaskEvent('oc_a');
    turnEnded('oc_c', 's-c', 't-c');
    turnEnded('oc_nobody', 's-n', 't-n');
    turnEnded('oc_steward', 's-st', 't-st');
    await elapse(TASK_ALERT_DEBOUNCE_MS);
    expect(delivered).toHaveLength(0);
  });

  it('还没有看板（库都没建）：群里的事件不建库、不提醒', async () => {
    turnEnded('oc_a', 's-a', 't-1');
    await elapse(TASK_ALERT_DEBOUNCE_MS * 2);
    expect(delivered).toHaveLength(0);
    expect(existsSync(decisionBoardDbPath(dir))).toBe(false);
  });

  it('默认关：不排提醒、看板不标提示，群状态照常显示；打开后新结果照常提醒', async () => {
    steward = { enabled: true, chatId: 'oc_steward' };
    const a = await add('修登录', 'oc_a');
    await elapse(MIN);
    turnEnded('oc_a', 's-a', 't-1');
    await elapse(TASK_ALERT_DEBOUNCE_MS * 2);
    expect(delivered).toHaveLength(0);
    const row = (await service.listView('active', 'owner')).items.find(i => i.seq === a)!;
    expect(row.taskChats).toEqual([expect.objectContaining({ chatId: 'oc_a', kind: 'delivered', summary: '修好了' })]);
    expect(row.taskHint).toBeUndefined();

    steward = { enabled: true, chatId: 'oc_steward', taskHints: false };
    turnEnded('oc_a', 's-a', 't-2');
    await elapse(TASK_ALERT_DEBOUNCE_MS * 2);
    expect(delivered).toHaveLength(0);

    steward = { enabled: true, chatId: 'oc_steward', taskHints: true };
    expect((await service.listView('active', 'owner')).items.find(i => i.seq === a)!.taskHint)
      .toMatchObject({ kind: 'task_delivered', chatId: 'oc_a' });
    turnEnded('oc_a', 's-a', 't-3', 'delivered', '打开后这轮也好了');
    await elapse(TASK_ALERT_DEBOUNCE_MS);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.prompt).toContain(`#${a} 修登录 — 子任务已交付`);
    expect(delivered[0]!.prompt).toContain('打开后这轮也好了');
  });

  it('投递抛错：不记已提醒，过一个防抖周期重试；最多投 3 次', async () => {
    await add('修登录', 'oc_a');
    await elapse(MIN);
    let attempts = 0;
    deliverImpl = async () => { attempts++; throw new Error('steward session busy'); };
    turnEnded('oc_a', 's-a', 't-1');
    await elapse(TASK_ALERT_DEBOUNCE_MS);
    expect(attempts).toBe(1);
    deliverImpl = async input => { delivered.push(input); return { sessionId: 's' }; };
    await elapse(TASK_ALERT_DEBOUNCE_MS);
    expect(delivered).toHaveLength(1);
    service.noteTaskEvent('oc_a');
    await elapse(TASK_ALERT_DEBOUNCE_MS);
    expect(delivered).toHaveLength(1);

    turnEnded('oc_a', 's-a', 't-2');
    deliverImpl = async () => { attempts++; throw new Error('banner posted, then session gone'); };
    await elapse(TASK_ALERT_DEBOUNCE_MS * 10);
    expect(attempts).toBe(4);
  });

  it('worker 入队前拒绝才重发；结果未知不重发', async () => {
    await add('修登录', 'oc_a');
    await elapse(MIN);
    turnEnded('oc_a', 's-a', 't-1');
    await elapse(TASK_ALERT_DEBOUNCE_MS);
    expect(delivered).toHaveLength(1);
    service.noteDeliveryFailure(delivered[0]!.turnId, 'receipt_timeout', 'worker.input_delivery_failed');
    await elapse(TASK_ALERT_DEBOUNCE_MS);
    expect(delivered).toHaveLength(1);

    turnEnded('oc_a', 's-a', 't-2');
    await elapse(TASK_ALERT_DEBOUNCE_MS);
    expect(delivered).toHaveLength(2);
    service.noteDeliveryFailure(delivered[1]!.turnId, 'worker_rejected:busy', 'worker.input_rejected_before_admission');
    await elapse(TASK_ALERT_DEBOUNCE_MS);
    expect(delivered).toHaveLength(3);
    expect(delivered[2]!.turnId).not.toBe(delivered[1]!.turnId);
  });
});

describe('看板列表和详情', () => {
  it('「进行中」里群里有新结果的排前面，其余顺序不变；管家更新后提示消失', async () => {
    const a = await add('A', 'oc_a');
    const b = await add('B', 'oc_b');
    const c = await add('C', 'oc_c');
    const base = (await service.listView('active', 'owner')).items.map(i => i.seq);
    await elapse(MIN);
    turnEnded('oc_b', 's-b', 't-b');
    sessions.set('oc_c', [{ sessionId: 's-c', larkAppId: APP, status: 'active' }]);
    rows.set('s-c', { status: 'working', busySinceAt: Date.now(), lastMessageAt: Date.now() });
    const list = (await service.listView('active', 'owner')).items;
    expect(list.map(i => i.seq)).toEqual([b, ...base.filter(s => s !== b)]);
    const byseq = new Map(list.map(i => [i.seq, i]));
    expect(byseq.get(b)).toMatchObject({ taskFresh: true, taskHint: { kind: 'task_delivered', chatId: 'oc_b' } });
    expect(byseq.get(c)).toMatchObject({ taskFresh: false, taskChats: [{ kind: 'working' }] });
    expect(byseq.get(a)).toMatchObject({ taskFresh: false, taskChats: [{ kind: 'no_session' }] });
    // 「全部」视图不重排。
    expect((await service.listView('all', 'owner')).items.map(i => i.seq)).toEqual(
      (service.list('all', 'owner')).items.map(i => i.seq));

    await service.cli({ action: 'set', ref: String(b), fields: { stage: '看过了' } }, { sessionId: 'sess-steward' });
    const detail = await service.detailView(b, 'owner');
    expect(detail.taskHint).toBeUndefined();
    expect(detail.taskFresh).toBe(false);
    expect(detail.taskChats).toEqual([expect.objectContaining({ chatId: 'oc_b', kind: 'delivered' })]);
  });

  it('管家群不算关联群；没有关联群的项不带群状态', async () => {
    const s = await add('管家自己的事', 'oc_steward');
    const n = (await service.cli({ action: 'add', title: '没群', noChat: '用例' }, { sessionId: 'sess-steward' }) as { item: { seq: number } }).item.seq;
    const items = new Map((await service.listView('active', 'owner')).items.map(i => [i.seq, i]));
    expect(items.get(s)!.taskChats).toBeUndefined();
    expect(items.get(n)!.taskChats).toBeUndefined();
  });
});

describe('管家设置与存储', () => {
  it('taskHints：默认关，只在打开时写 true；非布尔拒绝；与 closeHints 互不影响', () => {
    expect(normalizeStewardConfig({ enabled: true, chatId: 'oc_x' })).toEqual({ ok: true, value: { enabled: true, chatId: 'oc_x' } });
    expect(normalizeStewardConfig({ enabled: true, chatId: 'oc_x', taskHints: false })).toEqual({ ok: true, value: { enabled: true, chatId: 'oc_x' } });
    expect(normalizeStewardConfig({ enabled: true, chatId: 'oc_x', taskHints: true })).toEqual({ ok: true, value: { enabled: true, chatId: 'oc_x', taskHints: true } });
    expect(normalizeStewardConfig({ taskHints: false })).toEqual({ ok: true, value: null });
    expect(normalizeStewardConfig({ taskHints: true })).toEqual({ ok: true, value: { enabled: false, taskHints: true } });
    expect(normalizeStewardConfig({ enabled: true, chatId: 'oc_x', taskHints: 'no' })).toMatchObject({ ok: false });
    expect(stewardTaskHintsOn({ enabled: true, chatId: 'oc_x' })).toBe(false);
    expect(stewardTaskHintsOn({ enabled: true, chatId: 'oc_x', closeHints: true })).toBe(false);
    expect(stewardTaskHintsOn({ enabled: true, chatId: 'oc_x', taskHints: true })).toBe(true);
    expect(stewardTaskHintsOn({ enabled: false, chatId: 'oc_x', taskHints: true })).toBe(false);
    expect(stewardTaskHintsOn({ enabled: true, taskHints: true })).toBe(false);
  });

  it('管家指引里「子任务结果」一节只在开关开着时出现，且在定时巡检之前', () => {
    const on = stewardGuidePreset('zh', { enabled: true, chatId: 'oc_x', taskHints: true });
    const off = stewardGuidePreset('zh', { enabled: true, chatId: 'oc_x' });
    expect(on).toContain('## 子任务结果');
    expect(off).not.toContain('## 子任务结果');
    expect(on.indexOf('## 子任务结果')).toBeLessThan(on.indexOf('## 定时巡检'));
    expect(off).toBe(on.replace(/## 子任务结果[^]*?(?=## 定时巡检)/, ''));
    expect(stewardGuidePreset('zh', { enabled: true, chatId: 'oc_x', taskHints: false })).toBe(off);
    expect(stewardGuidePreset('en', { enabled: true, chatId: 'oc_x', taskHints: true })).toContain('## Subtask results');
    expect(stewardGuidePreset('en', { enabled: true, chatId: 'oc_x' })).not.toContain('## Subtask results');
  });

  it('改动前建的库：打开时补上 task_notified，旧行没有已提醒记录；版本号不升', () => {
    let store = DecisionBoardStore.open(dir);
    const seq = store.addItem(APP, { title: 'old', noChatReason: 'x' }, undefined, 500).item.seq;
    store.close();
    const db = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    db.exec('ALTER TABLE board_items DROP COLUMN task_notified;');
    db.close();
    store = DecisionBoardStore.open(dir);
    store.updateItem(APP, seq, { links: [{ kind: 'chat', ref: 'oc_a' }] }, undefined, 600);
    expect(store.itemsForChats(APP, ['oc_a'])).toEqual([expect.objectContaining({ taskNotified: [] })]);
    store.markTaskNotified(APP, [{ seq, key: 'task:delivered:s:t' }]);
    expect(store.itemsForChats(APP, ['oc_a'])[0]!.taskNotified).toEqual(['task:delivered:s:t']);
    store.unmarkTaskNotified(APP, [{ seq, key: 'task:delivered:s:t' }]);
    expect(store.itemsForChats(APP, ['oc_a'])[0]!.taskNotified).toEqual([]);
    expect(store.itemsForChats(APP, ['oc_b'])).toEqual([]);
    store.close();
    const raw = openDatabaseSyncOrThrow(decisionBoardDbPath(dir));
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    raw.close();
  });
});
