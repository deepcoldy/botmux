/**
 * flow M2 进程级验收（设计文档 §11 M2）：daemon 侧 FlowRunManager + 真实 runner（IPC 子进程）+
 * 假飞书传输。覆盖：
 *   - 触发绑定 → 进度卡 / 信号卡投递；卡片点击经前置门 → runner 裁决 → 冻结卡；
 *   - 陌生人 / 旧 version / 重复提交 / content 变化 / schema 不符 分别被拒；重发作废旧卡；
 *   - 投递失败时终端控制通道仍能提交；
 *   - daemon 断开 → run.interrupted → 冷启动补中断卡 → 恢复复用逻辑等待并刷新旧卡；
 *   - runner 崩溃 → 中断卡「取消」→ cancelOnStart 收尾并冻结遗留的信号卡；
 *   - 已完成的 run resume 全缓存（signal 重放）。
 *
 * 容器后端不可用的宿主上整组跳过——跳过不等于验证过。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRunContainers, containerPath, reclaimContainer, removeRunTreeIfEmpty } from '../src/flow/container.js';
import { FlowRunManager, type FlowCardTransport } from '../src/flow/daemon-manager.js';
import { loadJournal } from '../src/flow/journal.js';
import { readRunJson } from '../src/flow/runner.js';
import type { ControlRequest, ControlResponse, JournalRow, RunBinding } from '../src/flow/types.js';
import { FLOW_RESEND_ACTION, FLOW_RESUME_ACTION, FLOW_SIGNAL_ACTION } from '../src/im/lark/flow-card.js';
import { handleFlowCardAction, type FlowCardHandlerDeps } from '../src/im/lark/flow-card-handler.js';
import { cmdFlow } from '../src/cli/flow.js';
import { triggerFlowRun, type FlowTriggerDeps } from '../src/flow/trigger.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import { SRC_DIR, backend, harness, startRunner, summaryOf, waitFor } from './helpers/flow-e2e.js';

const describeIf = backend ? describe : describe.skip;

const OWNER = 'ou_owner';
const STRANGER = 'ou_stranger';
const APP = 'cli_flowtest';

const SIGNAL_SCRIPT = `
export default async function (ctx) {
  const { input, agent, signal, log } = ctx;
  const draft = await agent({ cli: 'codex', prompt: 'draft ' + input.topic });
  await log('drafted');
  const pick = await signal({ prompt: 'pick one', schema: { type: 'object', properties: { choice: { enum: ['a', 'b'] } }, required: ['choice'] } });
  if (!pick.ok) return { pick: pick.category };
  const final = await agent({ cli: 'codex', prompt: 'final ' + pick.value.choice });
  return { draft: draft.ok ? draft.value : draft.category, choice: pick.value.choice, final: final.ok ? final.value : final.category };
}
`;

interface FakeTransport extends FlowCardTransport {
  replies: Array<{ rootId: string; messageId: string; card: Card }>;
  patches: Array<{ messageId: string; card: Card }>;
  /** 返回 true 的卡片投递失败（模拟飞书报错）。 */
  failReply: (card: Card) => boolean;
}

interface Card {
  header: { template: string; title: { content: string } };
  elements: Array<Record<string, unknown>>;
}

function fakeTransport(): FakeTransport {
  let seq = 0;
  const t: FakeTransport = {
    replies: [],
    patches: [],
    failReply: () => false,
    async reply(rootId, cardJson) {
      const card = JSON.parse(cardJson) as Card;
      if (t.failReply(card)) throw new Error('lark 400: fake delivery failure');
      const messageId = `om_fake_${++seq}`;
      t.replies.push({ rootId, messageId, card });
      return messageId;
    },
    async patch(messageId, cardJson) {
      t.patches.push({ messageId, card: JSON.parse(cardJson) as Card });
    },
  };
  return t;
}

function buttonValues(card: Card): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (els: Array<Record<string, unknown>>): void => {
    for (const el of els) {
      if (el.tag === 'button') out.push(el.value as Record<string, unknown>);
      if (Array.isArray(el.actions)) visit(el.actions as Array<Record<string, unknown>>);
      if (Array.isArray(el.elements)) visit(el.elements as Array<Record<string, unknown>>);
    }
  };
  visit(card.elements);
  return out;
}

function title(card: Card): string {
  return card.header.title.content;
}

function toastOf(res: unknown): { type: string; content: string } {
  const t = (res as { toast?: { type: string; content: string } }).toast;
  if (!t) throw new Error(`expected a toast, got ${JSON.stringify(res).slice(0, 200)}`);
  return t;
}

function cardOf(res: unknown): Card {
  const c = res as Card;
  if (!c?.header) throw new Error(`expected a card, got ${JSON.stringify(res).slice(0, 200)}`);
  return c;
}

const children: ChildProcess[] = [];
const stderrs = new Map<ChildProcess, string>();
const dirs: string[] = [];
const runIds = new Set<string>();

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* */ }
      await new Promise<void>((r) => child.once('exit', () => r()));
    }
  }
  if (backend) {
    for (const runId of runIds) {
      for (const name of listRunContainers(backend, runId)) await reclaimContainer(backend, containerPath(backend, runId, name));
      removeRunTreeIfEmpty(backend, runId);
    }
  }
  runIds.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(script = SIGNAL_SCRIPT, fakeAgent = 'echo'): { dataDir: string; workingDir: string; binding: RunBinding; transport: FakeTransport; manager: FlowRunManager; newManager: (transport: FakeTransport) => FlowRunManager; lastChild: () => ChildProcess } {
  const dataDir = mkdtempSync(join(tmpdir(), 'flow-m2-'));
  dirs.push(dataDir);
  const workingDir = join(dataDir, 'work');
  writeFileSync(join(dataDir, 'outside.mjs'), script);
  mkdirSync(workingDir, { recursive: true });
  writeFileSync(join(workingDir, 'script.mjs'), script);
  const binding: RunBinding = { larkAppId: APP, chatId: 'oc_chat', rootId: 'om_root', sessionId: 'sess', ownerOpenId: OWNER, triggeredBy: OWNER, workingDir };
  let last: ChildProcess | null = null;
  const newManager = (transport: FakeTransport): FlowRunManager => new FlowRunManager({
    larkAppId: APP,
    dataDir,
    distDir: SRC_DIR,
    transport,
    log: { info: () => {}, warn: () => {} },
    controlTimeoutMs: 10_000,
    spawnRunner: (command, args, _runDir) => {
      const child = spawn(command, args, {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, BOTMUX_FLOW_TS_SRC_DIR: SRC_DIR, BOTMUX_FLOW_FAKE_AGENT: fakeAgent },
      });
      children.push(child);
      last = child;
      stderrs.set(child, '');
      child.stdout!.on('data', (c: Buffer) => stderrs.set(child, `${stderrs.get(child) ?? ''}${c.toString()}`));
      child.stderr!.on('data', (c: Buffer) => stderrs.set(child, `${stderrs.get(child) ?? ''}${c.toString()}`));
      return child;
    },
  });
  const transport = fakeTransport();
  return { dataDir, workingDir, binding, transport, manager: newManager(transport), newManager, lastChild: () => last! };
}

function handlerDeps(manager: FlowRunManager): FlowCardHandlerDeps {
  return {
    readBinding: (runId) => manager.readBinding(runId),
    canOperate: (_b, openId) => openId === OWNER,
    control: (runId, req) => manager.control(runId, req),
    resumeInterrupted: (runId, by, choice) => manager.resume(runId, by, choice),
    interruptedGenIsCurrent: (runId, gen) => manager.interruptedGenIsCurrent(runId, gen),
    scriptName: (runId) => manager.scriptName(runId),
    interruptedInfo: (runId) => manager.interruptedInfo(runId),
    lastRunPause: (runId) => manager.lastRunPause(runId),
  };
}

async function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function waitForSignalCard(transport: FakeTransport, from = 0): Promise<{ messageId: string; card: Card }> {
  await waitFor(() => transport.replies.slice(from).some((r) => title(r.card).startsWith('等待你的信号')), 60_000, `signal card (replies so far: ${transport.replies.map((r) => title(r.card)).join(' | ')})`);
  return transport.replies.slice(from).find((r) => title(r.card).startsWith('等待你的信号'))!;
}

function rowsOf(runDir: string): JournalRow[] {
  return loadJournal(runDir).raw.rows;
}

describeIf('flow M2：daemon 管理器 + 真实 runner + 假飞书', () => {
  beforeAll(() => {
    expect(existsSync(join(SRC_DIR, 'flow-runner.ts'))).toBe(true);
    // 管理器在本进程里解析 runner 入口（resolveFlowEntry 读 env），要从源码起
    process.env.BOTMUX_FLOW_TS_SRC_DIR = SRC_DIR;
  });

  it('launch：脚本必须在话题工作目录内；lint 早报错', async () => {
    const s = setup();
    const outside = await s.manager.launch({ script: '../outside.mjs', input: null, binding: s.binding });
    expect(outside).toMatchObject({ ok: false, error: expect.stringContaining('工作目录') });
    writeFileSync(join(s.workingDir, 'bad.mjs'), 'export default async function (ctx) { const fs = require("fs"); }');
    const bad = await s.manager.launch({ script: 'bad.mjs', input: null, binding: s.binding });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('静态检查') });
    expect(s.transport.replies).toHaveLength(0);
  });

  it('slogan + signal：卡片投递 → 陌生人/旧版本/重复/内容变化/schema 被拒 → 合法提交 → 完成；resume 全缓存', async () => {
    const s = setup();
    const launched = await s.manager.launch({ script: 'script.mjs', input: { topic: 'tea' }, binding: s.binding });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    const { runId, runDir } = launched as { runId: string; runDir: string };
    runIds.add(runId);
    // 进度卡立刻发在触发话题
    expect(s.transport.replies[0]!.rootId).toBe('om_root');
    expect(title(s.transport.replies[0]!.card)).toContain('flow · script.mjs');

    const sig = await waitForSignalCard(s.transport);
    expect(sig.messageId).toMatch(/^om_fake_/);
    const values = buttonValues(sig.card);
    const optionB = values.find((v) => v.action === FLOW_SIGNAL_ACTION && v.choice === '"b"')!;
    expect(optionB).toMatchObject({ runId, identity: expect.any(String), version: 1, field: 'choice' });
    const identity = optionB.identity as string;
    // journal：wait v1 + delivered
    await waitFor(() => rowsOf(runDir).some((r) => r.t === 'wait.delivery' && r.state === 'delivered' && r.version === 1), 10_000, 'wait.delivery row');
    const deps = handlerDeps(s.manager);

    // 陌生人
    expect(toastOf(await handleFlowCardAction(optionB, STRANGER, undefined, deps)).content).toContain('权限');
    // 进度卡显示「等待中」
    await waitFor(() => s.transport.patches.some((p) => p.messageId === s.transport.replies[0]!.messageId && title(p.card).includes('等待中')), 10_000, 'progress card paused');

    // 重发：v1 作废，v2 新卡；旧卡冻结成「已作废」
    const resend = values.find((v) => v.action === FLOW_RESEND_ACTION)!;
    expect(toastOf(await handleFlowCardAction(resend, OWNER, undefined, deps)).content).toContain('v2');
    const sig2 = await waitForSignalCard(s.transport, s.transport.replies.indexOf(sig) + 1);
    expect(sig2.messageId).not.toBe(sig.messageId);
    expect(title(sig2.card)).toContain('v2');
    await waitFor(() => s.transport.patches.some((p) => p.messageId === sig.messageId && title(p.card).startsWith('已作废')), 10_000, 'old card frozen as superseded');

    // 旧卡（v1）的按钮：前置门用 runner 当前 version 拒绝
    expect(toastOf(await handleFlowCardAction(optionB, OWNER, undefined, deps)).content).toContain('v2');
    // 绕过前置门直接打 runner：旧 version / content 变化 / schema 不符 / 过大 都被裁决拒绝
    const status = (await s.manager.control(runId, { t: 'status' })) as Extract<ControlResponse, { ok: true }>;
    expect(status.ok && status.waits[0]).toMatchObject({ identity, version: 2, delivery: 'resent' });
    const content = status.waits[0]!.content;
    const submit = (over: Partial<Extract<ControlRequest, { t: 'signal' }>>): Promise<ControlResponse | null> =>
      s.manager.control(runId, { t: 'signal', identity, version: 2, content, by: OWNER, value: { choice: 'b' }, ...over });
    expect(await submit({ version: 1 })).toMatchObject({ ok: false, code: 'stale_version' });
    expect(await submit({ content: 'bogus' })).toMatchObject({ ok: false, code: 'content_mismatch' });
    expect(await submit({ value: { choice: 'zzz' } })).toMatchObject({ ok: false, code: 'schema_mismatch' });
    expect(await submit({ value: { choice: 'a', pad: 'x'.repeat(70_000) } })).toMatchObject({ ok: false, code: 'payload_too_large' });
    expect(rowsOf(runDir).filter((r) => r.t === 'signal')).toHaveLength(0);

    // 合法提交：v2 卡片按钮 → 冻结卡；journal 先落 signal 行
    const optionB2 = buttonValues(sig2.card).find((v) => v.action === FLOW_SIGNAL_ACTION && v.choice === '"b"')!;
    const frozen = cardOf(await handleFlowCardAction(optionB2, OWNER, undefined, deps));
    expect(title(frozen)).toContain('已提交');
    const signalRows = rowsOf(runDir).filter((r): r is Extract<JournalRow, { t: 'signal' }> => r.t === 'signal');
    expect(signalRows).toHaveLength(1);
    expect(signalRows[0]).toMatchObject({ identity, version: 2, by: OWNER, value: { choice: 'b' } });
    // 重复提交 → consumed
    expect(await submit({})).toMatchObject({ ok: false, code: 'consumed' });
    expect(toastOf(await handleFlowCardAction(optionB2, OWNER, undefined, deps)).type).toBe('info');

    const exit = await exitOf(s.lastChild());
    expect(exit.code, stderrs.get(s.lastChild())).toBe(0);
    await waitFor(() => s.transport.patches.some((p) => p.messageId === s.transport.replies[0]!.messageId && title(p.card).includes('完成')), 10_000, 'progress card completed');
    const runJson = readRunJson(runDir)!;
    expect(runJson.status).toBe('completed');
    expect(runJson.binding).toEqual(s.binding);
    const finished = loadJournal(runDir).projection.finished!;
    expect(finished.returned).toEqual({ draft: 'echo:draft tea', choice: 'b', final: 'echo:final b' });
    // wait 行序：wait v1 → delivery delivered → superseded v1 → wait v2 → delivery resent → signal v2
    const waitRows = rowsOf(runDir).filter((r) => r.t === 'wait' || r.t === 'wait.delivery' || r.t === 'wait.superseded' || r.t === 'signal').map((r) => `${r.t}:${(r as { version: number }).version}${r.t === 'wait.delivery' ? `:${(r as { state: string }).state}` : ''}`);
    expect(waitRows).toEqual(['wait:1', 'wait.delivery:1:delivered', 'wait.superseded:1', 'wait:2', 'wait.delivery:2:resent', 'signal:2']);
    // 信号卡冻结：runner 的 wait.close(consumed) 也补了一刀（回显值）
    await waitFor(() => s.transport.patches.some((p) => p.messageId === sig2.messageId && title(p.card).startsWith('已提交')), 10_000, 'signal card frozen consumed');

    // resume 已完成的 run：signal 重放，不发新卡，返回值相同
    const replies = s.transport.replies.length;
    expect(await s.manager.resume(runId, OWNER)).toBeNull();
    const exit2 = await exitOf(s.lastChild());
    expect(exit2.code, stderrs.get(s.lastChild())).toBe(0);
    expect(s.transport.replies.length).toBe(replies);
    const again = loadJournal(runDir).projection.finished!;
    expect(again.replay).toBe('full');
    expect(again.returned).toEqual(finished.returned);
    expect(rowsOf(runDir).filter((r) => r.t === 'signal')).toHaveLength(1);
    expect(listRunContainers(backend!, runId)).toEqual([]);
  }, 180_000);

  it('投递失败：逻辑等待照常打开，终端控制通道提交仍成功', async () => {
    const s = setup();
    s.transport.failReply = (card) => title(card).startsWith('等待你的信号');
    const launched = await s.manager.launch({ script: 'script.mjs', input: { topic: 'tea' }, binding: s.binding });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    const { runId, runDir } = launched as { runId: string; runDir: string };
    runIds.add(runId);
    await waitFor(() => rowsOf(runDir).some((r) => r.t === 'wait.delivery' && r.state === 'failed'), 60_000, 'delivery failed row');
    const status = (await s.manager.control(runId, { t: 'status' })) as Extract<ControlResponse, { ok: true }>;
    expect(status.ok).toBe(true);
    expect(status.waits[0]).toMatchObject({ version: 1, delivery: 'failed', deliveryError: expect.stringContaining('fake delivery failure') });
    // 进度卡上标注投递失败
    await waitFor(() => s.transport.patches.some((p) => JSON.stringify(p.card).includes('投递失败')), 10_000, 'progress card notes failed delivery');
    // 终端：`botmux flow inspect` 列出等待与投递失败；`botmux flow signal` 走 unix 控制 socket 提交
    const out: string[] = [];
    const errLines: string[] = [];
    const cli = { dataDir: s.dataDir, stdout: (l: string) => out.push(l), stderr: (l: string) => errLines.push(l) };
    expect(await cmdFlow('inspect', [runId], cli)).toBe(0);
    expect(out.join('\n')).toContain('card failed: lark 400: fake delivery failure');
    expect(out.join('\n')).toContain(`bound to: app ${APP} chat oc_chat topic om_root`);
    expect(out.join('\n')).toContain(`botmux flow signal ${runId}`);
    const identity = status.waits[0]!.identity;
    // schema 不符 → 非零退出，带 runner 的裁决码
    expect(await cmdFlow('signal', [runId, identity, '--payload', '{"choice":"zzz"}'], cli)).toBe(1);
    expect(errLines.join('\n')).toContain('schema_mismatch');
    expect(await cmdFlow('signal', [runId, identity, '--payload', '{"choice":"a"}'], cli)).toBe(0);
    expect(out.join('\n')).toContain(`signal ${identity} v1 accepted`);
    // 重复提交
    expect(await cmdFlow('signal', [runId, identity, '--payload', '{"choice":"a"}'], cli)).toBe(1);
    const exit = await exitOf(s.lastChild());
    expect(exit.code, stderrs.get(s.lastChild())).toBe(0);
    expect(loadJournal(runDir).projection.finished!.returned).toEqual({ draft: 'echo:draft tea', choice: 'a', final: 'echo:final a' });
  }, 120_000);

  it('daemon 断开 → run.interrupted；冷启动补中断卡；恢复复用等待并刷新旧卡；提交后完成', async () => {
    const s = setup();
    const launched = await s.manager.launch({ script: 'script.mjs', input: { topic: 'tea' }, binding: s.binding });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    const { runId, runDir } = launched as { runId: string; runDir: string };
    runIds.add(runId);
    const sig = await waitForSignalCard(s.transport);
    const progressId = s.transport.replies[0]!.messageId;
    const gen1 = s.lastChild();

    // daemon 关闭：断 IPC，不再发卡
    s.manager.close();
    const exit = await exitOf(gen1);
    expect(exit.code, stderrs.get(gen1)).toBe(130); // interrupted 的退出码约定
    const interrupted = rowsOf(runDir).find((r): r is Extract<JournalRow, { t: 'run.interrupted' }> => r.t === 'run.interrupted')!;
    expect(interrupted.reason).toBe('daemon_disconnect');
    const identity = buttonValues(sig.card)[0]!.identity as string;
    expect(interrupted.inflight).toContain(identity);
    expect(loadJournal(runDir).projection.waits.get(identity)!.state).toBe('open');
    expect(s.transport.replies.filter((r) => title(r.card).startsWith('run 已中断'))).toHaveLength(0);

    // 新 daemon：cold-attach 补中断卡，进度卡冻结成已中断
    const t2 = fakeTransport();
    const m2 = s.newManager(t2);
    await m2.coldAttach();
    await waitFor(() => t2.replies.some((r) => title(r.card).startsWith('run 已中断')), 10_000, 'interrupted card');
    const interruptedCard = t2.replies.find((r) => title(r.card).startsWith('run 已中断'))!;
    expect(interruptedCard.rootId).toBe('om_root');
    expect(t2.patches.some((p) => p.messageId === progressId && title(p.card).includes('已中断'))).toBe(true);
    // 再 cold-attach 一次不重复发卡（每代一张）
    await m2.coldAttach();
    await new Promise((r) => setTimeout(r, 300));
    expect(t2.replies.filter((r) => title(r.card).startsWith('run 已中断'))).toHaveLength(1);
    expect(m2.listRuns()).toEqual([expect.objectContaining({ runId, status: 'interrupted', gen: 1 })]);

    // 中断卡「恢复」：gen 2；中断卡冻结；旧信号卡被刷新（不发新卡）
    const resumeBtn = buttonValues(interruptedCard.card).find((v) => v.action === FLOW_RESUME_ACTION && v.choice === 'resume')!;
    const deps2 = handlerDeps(m2);
    expect(toastOf(await handleFlowCardAction(resumeBtn, STRANGER, undefined, deps2)).content).toContain('权限');
    const frozenInterrupted = cardOf(await handleFlowCardAction(resumeBtn, OWNER, undefined, deps2));
    expect(title(frozenInterrupted)).toContain('已处理');
    await waitFor(() => t2.patches.some((p) => p.messageId === sig.messageId && JSON.stringify(p.card).includes('run 已恢复')), 60_000, 'old signal card refreshed');
    expect(t2.replies.filter((r) => title(r.card).startsWith('等待你的信号'))).toHaveLength(0);
    expect(readRunJson(runDir)!.gen).toBe(2);
    // 同一张中断卡再点：gen 已前进 → 冻结成失效
    expect(JSON.stringify(await handleFlowCardAction(resumeBtn, OWNER, undefined, deps2))).toContain('已失效');

    // 旧卡（v1）按钮仍有效：提交 → 完成
    const optionA = buttonValues(sig.card).find((v) => v.action === FLOW_SIGNAL_ACTION && v.choice === '"a"')!;
    const frozen = cardOf(await handleFlowCardAction(optionA, OWNER, undefined, deps2));
    expect(title(frozen)).toContain('已提交');
    const exit2 = await exitOf(s.lastChild());
    expect(exit2.code, stderrs.get(s.lastChild())).toBe(0);
    const finished = loadJournal(runDir).projection.finished!;
    expect(finished.status).toBe('completed');
    expect(finished.returned).toEqual({ draft: 'echo:draft tea', choice: 'a', final: 'echo:final a' });
    // 第一段 agent 结果复用（gen 2 只跑了 final）
    expect(rowsOf(runDir).filter((r) => r.t === 'started')).toHaveLength(2);
    expect(rowsOf(runDir).filter((r) => r.t === 'wait')).toHaveLength(1);
    expect(loadJournal(runDir).projection.waits.get(optionA.identity as string)!.state).toBe('consumed');
    m2.close();
  }, 180_000);

  it('runner 崩溃 → 中断卡；「取消」→ cancelOnStart：run 取消、遗留信号卡冻结', async () => {
    const s = setup();
    const launched = await s.manager.launch({ script: 'script.mjs', input: { topic: 'tea' }, binding: s.binding });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    const { runId, runDir } = launched as { runId: string; runDir: string };
    runIds.add(runId);
    const sig = await waitForSignalCard(s.transport);
    const gen1 = s.lastChild();
    gen1.kill('SIGKILL');
    await exitOf(gen1);
    await waitFor(() => s.transport.replies.some((r) => title(r.card).startsWith('run 已中断')), 15_000, 'interrupted card after crash');
    const interruptedCard = s.transport.replies.find((r) => title(r.card).startsWith('run 已中断'))!;
    expect(JSON.stringify(interruptedCard.card)).toContain('异常退出');
    const cancelBtn = buttonValues(interruptedCard.card).find((v) => v.action === FLOW_RESUME_ACTION && v.choice === 'cancel')!;
    const frozen = cardOf(await handleFlowCardAction(cancelBtn, OWNER, undefined, handlerDeps(s.manager)));
    expect(JSON.stringify(frozen)).toContain('已取消');
    const exit2 = await exitOf(s.lastChild());
    expect(exit2.code, stderrs.get(s.lastChild())).toBe(1); // canceled 的退出码约定
    expect(readRunJson(runDir)!.status).toBe('canceled');
    expect(loadJournal(runDir).projection.waits.get(buttonValues(sig.card)[0]!.identity as string)!.state).toBe('superseded');
    await waitFor(() => s.transport.patches.some((p) => p.messageId === sig.messageId && title(p.card).startsWith('已取消')), 10_000, 'signal card frozen canceled');
    await waitFor(() => s.transport.patches.some((p) => p.messageId === s.transport.replies[0]!.messageId && title(p.card).includes('已取消')), 10_000, 'progress card canceled');
    // 已取消的 run 不再是中断态
    expect(s.manager.interruptedInfo(runId)).toBeNull();
    expect(listRunContainers(backend!, runId)).toEqual([]);
  }, 120_000);

  it('slogan demo（examples/flow/slogan.mjs）：三路并发 → 表单信号卡 → 提交 index → 完成', async () => {
    const demo = readFileSync(join(process.cwd(), 'examples', 'flow', 'slogan.mjs'), 'utf8');
    const s = setup(demo, 'json');
    const launched = await s.manager.launch({ script: 'script.mjs', input: { topic: 'tea' }, binding: s.binding, limits: { maxConcurrency: 3 } });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    const { runId, runDir } = launched as { runId: string; runDir: string };
    runIds.add(runId);
    const sig = await waitForSignalCard(s.transport);
    // schema {index: integer} → 扁平表单：一个 flow_f_index 输入框 + form_submit 按钮
    expect(JSON.stringify(sig.card)).toContain('flow_f_index');
    expect(JSON.stringify(sig.card)).toContain('1. Write one warm slogan for tea');
    const submit = buttonValues(sig.card).find((v) => v.action === FLOW_SIGNAL_ACTION)!;
    const deps = handlerDeps(s.manager);
    // 越界 / 非整数：runner 按持久化 schema 拒绝
    expect(toastOf(await handleFlowCardAction(submit, OWNER, { flow_f_index: '9' }, deps)).type).toBe('error');
    expect(toastOf(await handleFlowCardAction(submit, OWNER, { flow_f_index: '1.5' }, deps)).type).toBe('error');
    const frozen = cardOf(await handleFlowCardAction(submit, OWNER, { flow_f_index: '2' }, deps));
    expect(title(frozen)).toContain('已提交');
    const exit = await exitOf(s.lastChild());
    expect(exit.code, stderrs.get(s.lastChild())).toBe(0);
    const finished = loadJournal(runDir).projection.finished!;
    expect(finished.status).toBe('completed');
    expect(finished.returned).toMatchObject({ slogan: 'Write one bold slogan for tea. Reply as JSON.' });
    expect(rowsOf(runDir).filter((r) => r.t === 'started')).toHaveLength(4);
    expect(rowsOf(runDir).some((r) => r.t === 'note' && r.text === '3/3 drafts ok')).toBe(true);
    await waitFor(() => s.transport.patches.some((p) => p.messageId === s.transport.replies[0]!.messageId && title(p.card).includes('完成')), 10_000, 'progress card completed');
  }, 120_000);

  it('webhook 触发：开话题 → 绑定 run（无真人 owner）→ 事件作为 input → wait 超时 → 群成员在卡上提交 → 完成并带回返回值', async () => {
    const WEBHOOK_SCRIPT = `
export default async function (ctx) {
  const { input, agent, signal } = ctx;
  const summary = await agent({ cli: 'codex', prompt: 'summarize ' + input.envelope.payload.ref });
  const pick = await signal({ prompt: 'ship it?', schema: { type: 'object', properties: { choice: { enum: ['a', 'b'] } }, required: ['choice'] } });
  if (!pick.ok) return { pick: pick.category };
  return { triggerId: input.triggerId, source: input.source.connectorId, instruction: input.instruction, summary: summary.ok ? summary.value : summary.category, choice: pick.value.choice };
}
`;
    const s = setup(WEBHOOK_SCRIPT);
    const seeds: Array<[string, string]> = [];
    const req: TriggerRequest = {
      source: { type: 'webhook', connectorId: 'conn_ci', requestId: 'req_1', receivedAt: '2026-09-08T00:00:00.000Z' },
      target: { kind: 'flow', botId: APP, chatId: 'oc_chat', script: 'script.mjs' },
      envelope: { format: 'botmux.webhook.v1', sourceName: 'ci', trusted: false, payload: { ref: 'refs/heads/main' } },
      instruction: 'Review the push.',
      options: { waitForFinalOutput: true, timeoutMs: 1_000 },
    };
    const deps: FlowTriggerDeps = {
      larkAppId: APP,
      manager: s.manager,
      apiOnly: () => false,
      sandboxed: () => false,
      isInChat: async () => true,
      messageChatId: async () => null,
      sendTopicSeed: async (chatId, text) => { seeds.push([chatId, text]); return 'om_seed'; },
      notify: async () => {},
      resolveWorkingDir: () => ({ ok: true, workingDir: s.workingDir }),
      topicMessage: (r) => `外部事件触发：${r.envelope.sourceName}`,
      newTriggerId: () => 'trg_e2e',
    };

    // 1 秒内到不了终局（脚本在等信号）→ wait_timeout，但 run 已起、卡片已发在种子话题里
    const first = await triggerFlowRun(req, deps);
    expect(first, JSON.stringify(first)).toMatchObject({ ok: false, errorCode: 'wait_timeout', target: { kind: 'flow', chatId: 'oc_chat', rootMessageId: 'om_seed' } });
    const runId = first.target!.flowRunId!;
    runIds.add(runId);
    expect(seeds).toEqual([['oc_chat', '外部事件触发：ci\nflow: script.mjs']]);
    expect(s.transport.replies[0]!.rootId).toBe('om_seed');
    const binding = s.manager.readBinding(runId)!;
    expect(binding).toMatchObject({ larkAppId: APP, chatId: 'oc_chat', rootId: 'om_seed', sessionId: null, ownerOpenId: null, triggeredBy: 'webhook:conn_ci', workingDir: s.workingDir, trigger: { kind: 'webhook', connectorId: 'conn_ci', triggerId: 'trg_e2e', source: 'ci' } });
    const runDir = join(s.dataDir, 'flow-runs', runId);
    expect(readRunJson(runDir)!.binding).toEqual(binding);

    // 信号卡到了触发话题；权限只看群的 canOperate（没有真人触发者可对照）：群成员可提交，陌生人不行
    const sig = await waitForSignalCard(s.transport);
    expect(sig.card).toBeTruthy();
    const optionA = buttonValues(sig.card).find((v) => v.action === FLOW_SIGNAL_ACTION && v.choice === '"a"')!;
    const cardDeps = handlerDeps(s.manager);
    expect(toastOf(await handleFlowCardAction(optionA, STRANGER, undefined, cardDeps)).content).toContain('权限');
    // 第二次等待（模拟调用方稍后再问）：卡上提交后 run 结束，waitForFinish 拿到终局
    const finishing = s.manager.waitForFinish(runId, 60_000);
    expect(title(cardOf(await handleFlowCardAction(optionA, OWNER, undefined, cardDeps)))).toContain('已提交');
    const outcome = await finishing;
    expect(outcome).toMatchObject({ kind: 'finished', status: 'completed', returned: { triggerId: 'trg_e2e', source: 'conn_ci', instruction: 'Review the push.', summary: 'echo:summarize refs/heads/main', choice: 'a' } });
    const exit = await exitOf(s.lastChild());
    expect(exit.code, stderrs.get(s.lastChild())).toBe(0);
    // 已结束的 run 再 waitForFinish：直接按 journal 结算，不挂起
    expect(await s.manager.waitForFinish(runId, 10)).toMatchObject({ kind: 'finished', status: 'completed' });

    // 同一事件再触发一次并同步等：这次直接给结果（脚本不等信号）
    writeFileSync(join(s.workingDir, 'quick.mjs'), `export default async function (ctx) { return { ref: ctx.input.envelope.payload.ref, by: ctx.input.source.type }; }`);
    const second = await triggerFlowRun({ ...req, target: { ...req.target, script: 'quick.mjs' }, options: { waitForFinalOutput: true, timeoutMs: 60_000 } }, deps);
    expect(second, JSON.stringify(second)).toMatchObject({ ok: true, action: 'completed', output: { content: '{"ref":"refs/heads/main","by":"webhook"}' }, flow: { status: 'completed', returned: { ref: 'refs/heads/main', by: 'webhook' } } });
    runIds.add(second.target!.flowRunId!);
    expect(listRunContainers(backend!, runId)).toEqual([]);
  }, 180_000);

  it('没有话题绑定的 run（终端 botmux flow run）调用 signal() 是硬错误：signal_unbound', async () => {
    const h = harness(SIGNAL_SCRIPT);
    const p = startRunner(h, 'run');
    const exit = await p.exit;
    expect(exit.code, p.stderr()).not.toBe(0);
    const summary = summaryOf(p);
    expect(summary.status).toBe('failed');
    const errors = loadJournal(h.runDir).projection.errors;
    expect(errors.some((e) => e.error.includes('signal_unbound') || e.code === 'signal_unbound')).toBe(true);
    expect(rowsOf(h.runDir).filter((r) => r.t === 'wait')).toHaveLength(0);
  }, 60_000);
});
