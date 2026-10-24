/**
 * 决策看板 daemon 服务：管家开关闸、CLI 动作、提交即投递（一批 = 一次投递 = 一条消息）、
 * 投递失败落在批次上并可重投、重启补投、同一批次不并发重复投递。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionBoardService, boardErrorStatus, type DecisionBoardServiceDeps } from '../src/core/decision-board/service.js';
import type { StewardConfig } from '../src/core/decision-board/model.js';

const APP = 'cli_steward';
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]).toString('base64');

let dir: string;
let steward: StewardConfig | undefined;
let locale: 'zh' | 'en';
let delivered: Array<Parameters<DecisionBoardServiceDeps['deliver']>[0]>;
let deliverImpl: DecisionBoardServiceDeps['deliver'];
let service: DecisionBoardService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-board-svc-'));
  steward = { enabled: true, chatId: 'oc_steward' };
  locale = 'zh';
  delivered = [];
  deliverImpl = async input => { delivered.push(input); return { sessionId: 'sess-steward' }; };
  service = new DecisionBoardService({
    dataDir: dir,
    larkAppId: () => APP,
    steward: () => steward,
    locale: () => locale,
    brand: () => 'feishu',
    dashboardOrigin: () => 'https://dash.example',
    ownerOpenId: () => 'ou_owner',
    ownerName: async () => '主人',
    timeZone: () => 'UTC',
    batchAttachmentsDir: batchId => join(dir, 'attachments', `board-${batchId}`),
    banner: ({ batchId, count }) => `收到 ${count} 项（#${batchId}）`,
    deliver: input => deliverImpl(input),
    log: () => {},
  });
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

async function addDecideItem(title = 'PR #1 合不合') {
  const res = await service.cli({
    action: 'add', title, fields: { question: '合不合？' }, options: ['A=合 → 风险小', 'B=不合'],
  }, { sessionId: 'sess-1' }) as { item: { seq: number; rev: number } };
  return res.item;
}

describe('管家开关', () => {
  it('没开管家时 CLI 一律拒绝，且不建库', async () => {
    steward = undefined;
    await expect(service.cli({ action: 'list' }, { sessionId: 's' })).rejects.toMatchObject({ code: 'not_steward' });
    expect(boardErrorStatus(await service.cli({ action: 'guide' }, { sessionId: 's' }).catch(e => e)).status).toBe(409);
    expect(service.meta().counts).toEqual({ decide: 0, active: 0, all: 0 });
    expect(existsSync(join(dir, 'decision-board.sqlite'))).toBe(false);
  });

  it('开了管家但还没用过看板：meta 探测不建库（侧边栏轮询 /boards 不应产生 sqlite 文件）', () => {
    expect(service.meta().counts).toEqual({ decide: 0, active: 0, all: 0 });
    expect(existsSync(join(dir, 'decision-board.sqlite'))).toBe(false);
  });
});

describe('CLI 动作', () => {
  it('add 返回飞书侧栏打开的链接；有问题默认待拍板；推荐项必须在选项里', async () => {
    const res = await service.cli({ action: 'add', title: 't', fields: { question: 'q', recommend: 'a' }, options: ['A=x', 'B=y'] }, { sessionId: 's' }) as any;
    expect(res.item).toMatchObject({ seq: 1, state: 'decide', stateLabel: '待拍板', recommend: 'A',
      url: `https://dash.example/board/${APP}/1` });
    expect(new URL(res.item.appLink).searchParams.get('url')).toBe(`https://dash.example/board/${APP}/1`);
    await expect(service.cli({ action: 'add', title: 't2', fields: { recommend: 'C' }, options: ['A=x'] }, { sessionId: 's' }))
      .rejects.toMatchObject({ code: 'unknown_recommend' });
    await expect(service.cli({ action: 'set', ref: '1', fields: { recommend: 'Z' } }, { sessionId: 's' }))
      .rejects.toMatchObject({ code: 'unknown_recommend' });
  });

  it('错误的选项 / 关联 / 状态给出可读原因', async () => {
    await expect(service.cli({ action: 'add', title: 't', options: ['无等号'] }, { sessionId: 's' })).rejects.toMatchObject({ code: 'invalid_option' });
    await expect(service.cli({ action: 'add', title: 't', links: ['pr=bad'] }, { sessionId: 's' })).rejects.toMatchObject({ code: 'invalid_link' });
    await expect(service.cli({ action: 'add', title: 't', fields: { state: 'merged' } }, { sessionId: 's' })).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(service.cli({ action: 'show', ref: '99' }, { sessionId: 's' })).rejects.toMatchObject({ code: 'item_not_found' });
  });

  it('set --clear-ask 清掉问题、选项和推荐', async () => {
    const item = await addDecideItem();
    await service.cli({ action: 'set', ref: `#${item.seq}`, clearAsk: true, fields: { state: 'active' } }, { sessionId: 's' });
    const shown = await service.cli({ action: 'show', ref: String(item.seq) }, { sessionId: 's' }) as any;
    expect(shown.item.question).toBeUndefined();
    expect(shown.item.options).toEqual([]);
    expect(shown.item.state).toBe('active');
  });

  it('英文界面的管家：自动状态历史写英文状态名', async () => {
    locale = 'en';
    const item = await addDecideItem();
    await service.cli({ action: 'set', ref: String(item.seq), fields: { state: 'active' } }, { sessionId: 's' });
    const shown = await service.cli({ action: 'show', ref: String(item.seq) }, { sessionId: 's' }) as any;
    const texts = shown.events.map((e: any) => e.text);
    expect(texts).toContain('Needs decision → In progress');
  });

  it('attach 校验图片文件头；guide 输出预置 + 追加', async () => {
    const item = await addDecideItem();
    const res = await service.cli({ action: 'attach', ref: String(item.seq), files: [{ name: 'a.png', mimeType: 'image/png', dataBase64: PNG_B64 }] }, { sessionId: 's' }) as any;
    expect(res.files).toHaveLength(1);
    await expect(service.cli({ action: 'attach', ref: String(item.seq), files: [{ name: 'a.png', mimeType: 'image/png', dataBase64: Buffer.from('nope').toString('base64') }] }, { sessionId: 's' }))
      .rejects.toMatchObject({ code: 'invalid_files' });
    steward = { enabled: true, chatId: 'oc_steward', guideText: '推进标准：只催不合' };
    const guide = await service.cli({ action: 'guide' }, { sessionId: 's' }) as any;
    expect(guide.guide.trimEnd().endsWith('推进标准：只催不合')).toBe(true);
  });
});

describe('提交与投递', () => {
  it('提交多项 = 一次投递：一条消息里带全部决定，附图随回合送出，批次标为已送达', async () => {
    const a = await addDecideItem('a');
    const b = await addDecideItem('b');
    const { file } = service.upload({ name: 'shot.png', mimeType: 'image/png', dataBase64: PNG_B64 });
    const da = service.putDraft(a.seq, 'owner', { choice: 'A', text: '合吧', fileIds: [file.id], baseRev: a.rev }).draft!;
    const db = service.putDraft(b.seq, 'owner', { text: '先别动', baseRev: b.rev }).draft!;
    const res = await service.submit({ author: 'owner', submitter: 'local', nonce: 'n1', items: [
      { seq: a.seq, draftUpdatedAt: da.updatedAt }, { seq: b.seq, draftUpdatedAt: db.updatedAt },
    ] });
    expect(res.batch).toMatchObject({ id: 1, delivery: 'delivered', sessionId: 'sess-steward', attempts: 1 });
    expect(delivered).toHaveLength(1);
    const msg = delivered[0];
    expect(msg.chatId).toBe('oc_steward');
    expect(msg.ownerOpenId).toBe('ou_owner');
    expect(msg.turnId).toMatch(new RegExp(`^board:${APP}:1$`));
    expect(msg.banner).toBe('收到 2 项（#1）');
    expect(msg.prompt).toContain('【决策看板 · 批次 #1】主人');
    expect(msg.prompt).toContain('#1 a（待拍板）\n  选：A 合\n  说明：合吧\n  附图：1 张');
    expect(msg.prompt).toContain('#2 b（待拍板）\n  选：未选\n  说明：先别动');
    expect(msg.attachments).toHaveLength(1);
    expect(readFileSync(msg.attachments[0].path).toString('base64')).toBe(PNG_B64);
    // 草稿已清空，决定待管家执行
    const pending = await service.cli({ action: 'pending' }, { sessionId: 's' }) as any;
    expect(pending.decisions.map((d: any) => d.seq)).toEqual([a.seq, b.seq]);
  });

  it('管家没选群：批次落库但标为失败，补上群后重投成功', async () => {
    steward = { enabled: true };
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'B', baseRev: a.rev }).draft!;
    const res = await service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    expect(res.batch).toMatchObject({ delivery: 'failed', error: 'steward_chat_missing' });
    expect(delivered).toHaveLength(0);
    steward = { enabled: true, chatId: 'oc_steward' };
    const again = await service.redeliver(res.batch.id);
    expect(again.batch.delivery).toBe('delivered');
    expect(delivered).toHaveLength(1);
  });

  it('投递抛错记在批次上；daemon 起来后补投；已送达的不再投', async () => {
    deliverImpl = async () => { throw new Error('worker down'); };
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'A', baseRev: a.rev }).draft!;
    const res = await service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    expect(res.batch).toMatchObject({ delivery: 'failed', error: 'worker down' });
    deliverImpl = async input => { delivered.push(input); return { sessionId: 's2' }; };
    await service.redeliverUndelivered();
    expect(delivered).toHaveLength(1);
    await service.redeliverUndelivered();
    expect(delivered).toHaveLength(1);
    // 同一 nonce 再点一次：返回原批次，不再投递
    const dup = await service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    expect(dup.duplicate).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  it('重投沿用同一个稳定 turnId（board:<app>:<批次>），worker 内存去重据此挡住二次执行', async () => {
    const seen: string[] = [];
    deliverImpl = async input => { seen.push(input.turnId); throw new Error('boom'); };
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'A', baseRev: a.rev }).draft!;
    const res = await service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    deliverImpl = async input => { seen.push(input.turnId); delivered.push(input); return { sessionId: 's2' }; };
    await service.redeliver(res.batch.id);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toBe(`board:${APP}:${res.batch.id}`);
  });

  it('dispatched 在调用 deliver 之前就落库（崩溃在 deliver 内部时重启能识别结果未知）', async () => {
    let deliveryAtEntry: string | undefined;
    let rowAtEntry: string | undefined;
    deliverImpl = async input => {
      deliveryAtEntry = input.turnId;
      rowAtEntry = (service as any).store().getBatch(APP, 1)?.delivery;
      throw new Error('boom');
    };
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'A', baseRev: a.rev }).draft!;
    await service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    expect(rowAtEntry).toBe('dispatched');
    expect(deliveryAtEntry).toBe(`board:${APP}:1`);
    // deliver 抛错后退回 failed，可重投。
    expect((service as any).store().getBatch(APP, 1).delivery).toBe('failed');
  });

  it('in-flight dispatched：redeliver 返回 dispatched 不判死、同 nonce 不二次投递；放行后终态 delivered', async () => {
    let release: ((r: { sessionId: string }) => void) | undefined;
    const deliverCalls: string[] = [];
    deliverImpl = input => new Promise<{ sessionId: string }>((resolve) => {
      deliverCalls.push(input.turnId);
      release = r => resolve(r);
    });
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'A', baseRev: a.rev }).draft!;
    // 不 await：模拟 owner 点完提交、deliver() 还在飞。
    const inFlight = service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    await vi.waitFor(() => expect(deliverCalls).toHaveLength(1));
    expect((service as any).store().getBatch(APP, 1).delivery).toBe('dispatched');

    // 页面此时点「重新投递」：必须返回 in-flight 批次（dispatched），不能 settle 成 failed。
    const again = await service.redeliver(1);
    expect(again.batch.delivery).toBe('dispatched');
    // 同一 nonce 再提交：返回当前批次，不发起第二次投递。
    const dup = await service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    expect(dup.duplicate).toBe(true);
    expect(dup.batch.delivery).toBe('dispatched');
    expect(deliverCalls).toEqual([`board:${APP}:1`]);

    // 放行真正的投递：终态必须 delivered，不能被 in-flight 期间的任何判断挡在 failed。
    release!({ sessionId: 'sess-x' });
    expect((await inFlight).batch.delivery).toBe('delivered');
    expect((service as any).store().getBatch(APP, 1).delivery).toBe('delivered');
  });

  it('跨重启残留的 dispatched：补投只转 failed(delivery_interrupted) 不二次投递，再点重投才真正发出', async () => {
    // 忠实构造残留行：旧进程的 deliver() 永不返回（模拟死在投递途中），dispatched 已落库。
    deliverImpl = () => new Promise(() => {});
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'A', baseRev: a.rev }).draft!;
    const inFlight = service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    inFlight.catch(() => {});
    await vi.waitFor(() => expect((service as any).store().getBatch(APP, 1).delivery).toBe('dispatched'));
    service.close(); // 旧进程「死亡」，deliver 的 Promise 不再有收敛者

    const restartedDeliveries: unknown[] = [];
    const restarted = new DecisionBoardService({
      dataDir: dir,
      larkAppId: () => APP,
      steward: () => steward,
      locale: () => 'zh',
      brand: () => 'feishu',
      dashboardOrigin: () => undefined,
      ownerOpenId: () => 'ou_owner',
      ownerName: async () => undefined,
      timeZone: () => undefined,
      batchAttachmentsDir: () => '',
      banner: () => '',
      deliver: async input => { restartedDeliveries.push(input); return { sessionId: 's2' }; },
      log: () => {},
    } as DecisionBoardServiceDeps);

    // undeliveredBatches 必须显式含这批，否则补投循环不进（上一轮测试空转的教训）。
    const undelivered = (restarted as any).store().undeliveredBatches(APP).map((b: any) => [b.id, b.delivery]);
    expect(undelivered).toContainEqual([1, 'dispatched']);

    await restarted.redeliverUndelivered();
    // 不重发，只收敛成 failed/interrupted。
    expect(restartedDeliveries).toHaveLength(0);
    const settled = (restarted as any).store().getBatch(APP, 1);
    expect(settled.delivery).toBe('failed');
    expect(settled.error).toBe('delivery_interrupted');

    // owner 在页面再点一次重投：failed 行才真正发起投递，沿用同一 turnId。
    const manual = await restarted.redeliver(1);
    expect(manual.batch.delivery).toBe('delivered');
    expect(restartedDeliveries).toHaveLength(1);
    expect((restartedDeliveries[0] as any).turnId).toBe(`board:${APP}:1`);
    restarted.close();
  });

  it('同 nonce 提交撞上跨重启残留的 dispatched：收敛成 failed，不把死行当成功也不直接重发', async () => {
    deliverImpl = () => new Promise(() => {});
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'A', baseRev: a.rev }).draft!;
    const inFlight = service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    inFlight.catch(() => {});
    await vi.waitFor(() => expect((service as any).store().getBatch(APP, 1).delivery).toBe('dispatched'));
    service.close();

    const deliveries: unknown[] = [];
    const restarted = new DecisionBoardService({
      dataDir: dir,
      larkAppId: () => APP,
      steward: () => steward,
      locale: () => 'zh',
      brand: () => 'feishu',
      dashboardOrigin: () => undefined,
      ownerOpenId: () => 'ou_owner',
      ownerName: async () => undefined,
      timeZone: () => undefined,
      batchAttachmentsDir: () => '',
      banner: () => '',
      deliver: async input => { deliveries.push(input); return { sessionId: 's2' }; },
      log: () => {},
    } as DecisionBoardServiceDeps);
    // 同 nonce 重复提交（草稿条目已被首次提交删过，store 对 nonce 重复直接返回既有批次）。
    const dup = await restarted.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    expect(dup.duplicate).toBe(true);
    expect(dup.batch.delivery).toBe('failed');
    expect(dup.batch.error).toBe('delivery_interrupted');
    expect(deliveries).toHaveLength(0);
    restarted.close();
  });

  it('worker 失败回执早于 deliver resolve：终态保持 failed，不被 delivered 覆盖', async () => {
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'A', baseRev: a.rev }).draft!;
    deliverImpl = async input => {
      // 模拟 worker 的失败回执先到（结果未知，权威判定失败），deliver 的 Promise 随后才 resolve。
      service.noteDeliveryFailure(input.turnId, 'receipt timeout');
      return { sessionId: 'sess-x' };
    };
    const res = await service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    expect(res.batch.delivery).toBe('failed');
    expect(res.batch.error).toBe('receipt timeout');
  });

  it('in-flight 期间 redeliverUndelivered 不动在途批次（不 settle、不重发、不打误导日志）', async () => {
    let release: ((r: { sessionId: string }) => void) | undefined;
    const deliverCalls: string[] = [];
    deliverImpl = input => new Promise<{ sessionId: string }>(resolve => {
      deliverCalls.push(input.turnId);
      release = r => resolve(r);
    });
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'A', baseRev: a.rev }).draft!;
    const inFlight = service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    inFlight.catch(() => {});
    await vi.waitFor(() => expect((service as any).store().getBatch(APP, 1).delivery).toBe('dispatched'));

    // 启动补投扫到这个批次时投递仍在飞：必须跳过，不能把它 settle 成 interrupted。
    await service.redeliverUndelivered();
    const row = (service as any).store().getBatch(APP, 1);
    expect(row.delivery).toBe('dispatched');
    expect(row.error).toBeFalsy();
    expect(deliverCalls).toHaveLength(1);

    release!({ sessionId: 'sess-x' });
    expect((await inFlight).batch.delivery).toBe('delivered');
  });

  it('deliverBatch 直接打到残留 dispatched 行（无在途投递）时收敛为 failed/interrupted', async () => {
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'A', baseRev: a.rev }).draft!;
    // 造出残留行：旧进程投递中途死亡。
    deliverImpl = () => new Promise(() => {});
    const inFlight = service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    inFlight.catch(() => {});
    await vi.waitFor(() => expect((service as any).store().getBatch(APP, 1).delivery).toBe('dispatched'));
    service.close();

    // 新进程（delivering 为空）直接对残留行调 deliverBatch：入口的 settle 必须把它转成
    // failed/interrupted 且不调用 deliver，而不是把结果未知行当成功或盲目重发。
    const restartedDeliveries: unknown[] = [];
    const restarted = new DecisionBoardService({
      dataDir: dir,
      larkAppId: () => APP,
      steward: () => steward,
      locale: () => 'zh',
      brand: () => 'feishu',
      dashboardOrigin: () => undefined,
      ownerOpenId: () => 'ou_owner',
      ownerName: async () => undefined,
      timeZone: () => undefined,
      batchAttachmentsDir: () => '',
      banner: () => '',
      deliver: async input => { restartedDeliveries.push(input); return { sessionId: 's2' }; },
      log: () => {},
    } as DecisionBoardServiceDeps);
    const settled = await restarted.deliverBatch(1);
    expect(settled.delivery).toBe('failed');
    expect(settled.error).toBe('delivery_interrupted');
    expect(restartedDeliveries).toHaveLength(0);
    restarted.close();
  });

  it('noteDeliveryFailure 只认本管家的 board 回合；delivered 终态不改', async () => {
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'A', baseRev: a.rev }).draft!;
    const res = await service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    expect(res.batch.delivery).toBe('delivered');
    service.noteDeliveryFailure(`board:${APP}:${res.batch.id}`, 'late');
    expect((service as any).store().getBatch(APP, res.batch.id).delivery).toBe('delivered');
    service.noteDeliveryFailure('board:other_app:99', 'x');
    service.noteDeliveryFailure('om_x', 'x');
    expect((service as any).store().getBatch(APP, res.batch.id).delivery).toBe('delivered');
  });

  it('同一批次的并发投递只投一次', async () => {
    let release: (() => void) | undefined;
    deliverImpl = input => new Promise(resolve => { release = () => { delivered.push(input); resolve({ sessionId: 's' }); }; });
    steward = { enabled: true };
    const a = await addDecideItem();
    const d = service.putDraft(a.seq, 'owner', { choice: 'A', baseRev: a.rev }).draft!;
    const res = await service.submit({ author: 'owner', nonce: 'n', items: [{ seq: a.seq, draftUpdatedAt: d.updatedAt }] });
    steward = { enabled: true, chatId: 'oc_steward' };
    const p1 = service.deliverBatch(res.batch.id);
    const p2 = service.deliverBatch(res.batch.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release!();
    const [b1, b2] = await Promise.all([p1, p2]);
    expect(b1.delivery).toBe('delivered');
    expect(b2).toEqual(b1);
    expect(delivered).toHaveLength(1);
  });
});
