/**
 * v3-loop-grant-card(.handler).test.ts — 耗尽 loop 追加一轮卡构建 + 点击处理。
 * 镜像 v3-blocked-card 系测试：卡片纯函数断言 + handler 的注入 seam 测试，
 * 含 stale 防护（expectedIteration —— expectedAttemptId 的同款教训）。
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildV3LoopGrantCard,
  v3LoopGrantCardNonce,
  V3_LOOP_GRANT_ACTION,
  type V3LoopGrantActionValue,
} from '../src/im/lark/v3-loop-grant-card.js';
import { handleV3LoopGrantAction } from '../src/im/lark/v3-loop-grant-card-handler.js';
import { birthRun } from '../src/workflows/v3/grill-state.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';

const INPUT = {
  runId: 'demo-run-260606-1300',
  loopId: 'fix',
  iteration: 3,
  maxIterations: 3,
  detail: 'result.passed=false (iteration 3/3)',
};

describe('buildV3LoopGrantCard', () => {
  it('pending 卡：orange header + 追加按钮 value 带 action/runId/loopId/iteration/nonce', () => {
    const card = JSON.parse(buildV3LoopGrantCard(INPUT));
    expect(card.header.template).toBe('orange');
    expect(card.header.title.content).toContain('fix');
    const budget = card.elements.find((e: any) => e.tag === 'div' && e.fields);
    expect(JSON.stringify(budget)).toContain('3/3');
    const actionEl = card.elements.find((e: any) => e.tag === 'action' && e.actions[0]?.value);
    const value = actionEl.actions[0].value as V3LoopGrantActionValue;
    expect(value).toMatchObject({
      action: V3_LOOP_GRANT_ACTION,
      runId: INPUT.runId,
      loopId: 'fix',
      iteration: 3,
      nonce: v3LoopGrantCardNonce(INPUT.runId, 'fix', 3),
    });
  });

  it('granted 冻结卡：green + 无追加按钮 + 显示新一轮', () => {
    const card = JSON.parse(
      buildV3LoopGrantCard({ ...INPUT, grantedNow: { nextIteration: 4, by: 'ou_x' } }),
    );
    expect(card.header.template).toBe('green');
    const json = JSON.stringify(card);
    expect(json).toContain('第 4 轮');
    expect(json).not.toContain(V3_LOOP_GRANT_ACTION);
  });

  it('detail 注入安全：lark_md 特殊字符被转义', () => {
    const card = JSON.parse(buildV3LoopGrantCard({ ...INPUT, detail: '*bold* [link](x)' }));
    const reason = card.elements.find((e: any) => e.tag === 'div' && e.text?.content?.includes('最后一轮结果'));
    expect(reason.text.content).toContain('\\*bold\\*');
  });
});

describe('handleV3LoopGrantAction', () => {
  /** 种一个耗尽 blocked 的 loop run（iteration 1 / maxIterations 1 语义）。 */
  function seed(base: string, runId: string): string {
    const { runDir } = birthRun({
      goal: 'g', baseDir: base, runId,
      chatBinding: { larkAppId: 'cli_test', chatId: 'oc_chat', rootMessageId: 'om_root' },
    });
    const journalPath = join(runDir, 'journal.ndjson');
    appendEvent(journalPath, { type: 'runStarted', runId });
    appendEvent(journalPath, { type: 'loopStarted', loopId: 'fix' });
    appendEvent(journalPath, { type: 'loopIterationStarted', loopId: 'fix', iteration: 1 });
    appendEvent(journalPath, {
      type: 'loopIterationDecision', loopId: 'fix', iteration: 1,
      decision: 'exhausted', detail: 'result.passed=false (iteration 1/1)',
    });
    appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'fix' });
    return runDir;
  }

  const value = (runId: string, iteration = 1): V3LoopGrantActionValue => ({
    action: V3_LOOP_GRANT_ACTION,
    runId,
    loopId: 'fix',
    iteration,
    nonce: v3LoopGrantCardNonce(runId, 'fix', iteration),
  });

  it('点击 → grant append + driveRun + 冻结「已追加」卡', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-grant-card-'));
    const runId = 'grant-260606-0001';
    const runDir = seed(base, runId);
    const driveRun = vi.fn();
    const res: any = await handleV3LoopGrantAction(value(runId), 'ou_op', { baseDir: base, driveRun });
    expect(driveRun).toHaveBeenCalledWith(runId);
    expect(res.header.template).toBe('green');
    expect(JSON.stringify(res)).toContain('第 2 轮');
    const granted = readJournal(join(runDir, 'journal.ndjson')).find((e) => e.type === 'loopIterationGranted');
    expect(granted).toMatchObject({ loopId: 'fix', fromIteration: 1, by: 'ou_op' });
    rmSync(base, { recursive: true, force: true });
  });

  it('二次点击（grant 未消费）→ already toast + 仍 driveRun 兜底，不双写', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-grant-card-'));
    const runId = 'grant-260606-0002';
    const runDir = seed(base, runId);
    const driveRun = vi.fn();
    await handleV3LoopGrantAction(value(runId), 'ou_op', { baseDir: base, driveRun });
    const res: any = await handleV3LoopGrantAction(value(runId), 'ou_op', { baseDir: base, driveRun });
    expect(res.toast.content).toContain('已在追加重跑中');
    expect(driveRun).toHaveBeenCalledTimes(2);
    const grants = readJournal(join(runDir, 'journal.ndjson')).filter((e) => e.type === 'loopIterationGranted');
    expect(grants).toHaveLength(1);
    rmSync(base, { recursive: true, force: true });
  });

  it('stale 旧卡：loop 已进入新一轮再耗尽，旧 iteration 的卡必须失效', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-grant-card-'));
    const runId = 'grant-260606-0003';
    const runDir = seed(base, runId);
    const journalPath = join(runDir, 'journal.ndjson');
    // 第一张卡被点掉 → grant 消费 → 第 2 轮跑完再耗尽（新卡是 iteration 2 的）。
    appendEvent(journalPath, { type: 'loopIterationGranted', loopId: 'fix', fromIteration: 1 });
    appendEvent(journalPath, { type: 'loopIterationStarted', loopId: 'fix', iteration: 2 });
    appendEvent(journalPath, { type: 'loopIterationDecision', loopId: 'fix', iteration: 2, decision: 'exhausted' });
    appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'fix' });

    const driveRun = vi.fn();
    // iteration 1 的旧卡 → stale toast，绝不能再 +1 轮。
    const res: any = await handleV3LoopGrantAction(value(runId, 1), 'ou_op', { baseDir: base, driveRun });
    expect(res.toast.content).toContain('新一轮');
    expect(driveRun).not.toHaveBeenCalled();
    const grants = readJournal(journalPath).filter((e) => e.type === 'loopIterationGranted');
    expect(grants).toHaveLength(1); // 只有 seed 后手工补的那一次

    // iteration 2 的新卡正常工作。
    const ok: any = await handleV3LoopGrantAction(value(runId, 2), 'ou_op', { baseDir: base, driveRun });
    expect(ok.header.template).toBe('green');
    rmSync(base, { recursive: true, force: true });
  });

  it('nonce 不匹配 / 非法 runId / 无权限 / 非耗尽态 → toast 不动 journal', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-grant-card-'));
    const runId = 'grant-260606-0004';
    const runDir = seed(base, runId);
    const driveRun = vi.fn();

    const badNonce: any = await handleV3LoopGrantAction({ ...value(runId), nonce: 'wrong' }, 'ou_op', { baseDir: base, driveRun });
    expect(badNonce.toast.type).toBe('warning');

    const badId: any = await handleV3LoopGrantAction({ ...value(runId), runId: '../escape' }, 'ou_op', { baseDir: base, driveRun });
    expect(badId.toast.type).toBe('warning');

    const denied: any = await handleV3LoopGrantAction(value(runId), 'ou_op', {
      baseDir: base, driveRun, canResolve: () => false,
    });
    expect(denied.toast.content).toContain('权限');
    expect(driveRun).not.toHaveBeenCalled();
    expect(readJournal(join(runDir, 'journal.ndjson')).some((e) => e.type === 'loopIterationGranted')).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});
