/**
 * v3-revisit-grant-card(.handler).test.ts — 回溯预算耗尽卡构建 + 点击处理。
 * 镜像 v3-loop-grant-card 系测试:卡片纯函数断言 + handler 注入 seam,含 stale
 * 防护(attemptId nonce —— expectedAttemptId 的同款教训)+ scope 正确性(pair/run)。
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildV3RevisitGrantCard,
  v3RevisitGrantCardNonce,
  V3_REVISIT_GRANT_ACTION,
  type V3RevisitGrantActionValue,
} from '../src/im/lark/v3-revisit-grant-card.js';
import { handleV3RevisitGrantAction } from '../src/im/lark/v3-revisit-grant-card-handler.js';
import { birthRun } from '../src/workflows/v3/grill-state.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';

const INPUT = {
  runId: 'demo-run-260608-1300',
  sourceNodeId: 'C',
  toNodeId: 'A',
  tier: 'pair' as const,
  attemptId: 'C#002/attempts/001',
  detail: 'revisit budget exhausted for C->A (1/1) — grant +1 (this pair) to continue',
};

describe('buildV3RevisitGrantCard', () => {
  it('pending 卡:orange header + 准许按钮 value 带 action/runId/source/to/tier/attemptId/nonce', () => {
    const card = JSON.parse(buildV3RevisitGrantCard(INPUT));
    expect(card.header.template).toBe('orange');
    expect(card.header.title.content).toContain('C → A');
    const actionEl = card.elements.find((e: any) => e.tag === 'action' && e.actions[0]?.value);
    const value = actionEl.actions[0].value as V3RevisitGrantActionValue;
    expect(value).toMatchObject({
      action: V3_REVISIT_GRANT_ACTION,
      runId: INPUT.runId,
      sourceNodeId: 'C',
      toNodeId: 'A',
      tier: 'pair',
      attemptId: 'C#002/attempts/001',
      nonce: v3RevisitGrantCardNonce(INPUT.runId, 'C', 'C#002/attempts/001'),
    });
  });

  it('run-wide 耗尽:标题/层级显示整个 run', () => {
    const card = JSON.parse(buildV3RevisitGrantCard({ ...INPUT, tier: 'run' }));
    expect(card.header.title.content).toContain('整个 run');
    expect(JSON.stringify(card)).toContain('per-run');
  });

  it('granted 冻结卡:green + 无准许按钮', () => {
    const card = JSON.parse(buildV3RevisitGrantCard({ ...INPUT, grantedNow: { by: 'ou_x' } }));
    expect(card.header.template).toBe('green');
    expect(JSON.stringify(card)).not.toContain(V3_REVISIT_GRANT_ACTION);
  });

  it('detail 注入安全:lark_md 特殊字符被转义', () => {
    const card = JSON.parse(buildV3RevisitGrantCard({ ...INPUT, detail: '*bold* [x](y)' }));
    const el = card.elements.find((e: any) => e.tag === 'div' && e.text?.content?.includes('情况'));
    expect(el.text.content).toContain('\\*bold\\*');
  });
});

describe('handleV3RevisitGrantAction', () => {
  /** 种一个 C→A 回溯预算耗尽的 blocked run(per-pair 1/1)。 */
  function seed(base: string, runId: string): string {
    const { runDir } = birthRun({
      goal: 'g', baseDir: base, runId,
      chatBinding: { larkAppId: 'cli_test', chatId: 'oc_chat', rootMessageId: 'om_root' },
    });
    const journalPath = join(runDir, 'journal.ndjson');
    appendEvent(journalPath, { type: 'runStarted', runId });
    appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'C', instanceId: 'C#002', attemptId: 'C#002/attempts/001' });
    // 已回溯过 1 次(pair 1/1 耗尽)
    appendEvent(journalPath, { type: 'nodeRevisitRequested', nodeId: 'C', instanceId: 'C#001', attemptId: 'C#001/attempts/001', toNodeId: 'A' });
    appendEvent(journalPath, {
      type: 'nodeBlocked', nodeId: 'C', instanceId: 'C#002', attemptId: 'C#002/attempts/001',
      errorClass: 'resultInvalid', errorCode: 'REVISIT_BUDGET_EXHAUSTED', message: 'exhausted', revisitTo: 'A',
    });
    appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'C' });
    return runDir;
  }

  const value = (runId: string, attemptId = 'C#002/attempts/001'): V3RevisitGrantActionValue => ({
    action: V3_REVISIT_GRANT_ACTION,
    runId, sourceNodeId: 'C', toNodeId: 'A', tier: 'pair', attemptId,
    nonce: v3RevisitGrantCardNonce(runId, 'C', attemptId),
  });

  it('点击 → grant append + 原子 retry + driveRun + 冻结 green 卡', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-revisit-grant-'));
    const runId = 'rg-260608-0001';
    const runDir = seed(base, runId);
    const driveRun = vi.fn();
    const res: any = await handleV3RevisitGrantAction(value(runId), 'ou_op', { baseDir: base, driveRun });
    expect(driveRun).toHaveBeenCalledWith(runId);
    expect(res.header.template).toBe('green');
    const events = readJournal(join(runDir, 'journal.ndjson'));
    expect(events.find((e) => e.type === 'revisitBudgetGranted')).toMatchObject({ sourceNodeId: 'C', toNodeId: 'A', by: 'ou_op' });
    // 原子 retry:C 进入 attempts/002
    expect(events.find((e) => e.type === 'nodeRetryRequested')).toMatchObject({ nodeId: 'C', nextAttemptId: 'C#002/attempts/002' });
    rmSync(base, { recursive: true, force: true });
  });

  it('二次点击(retry 后已 pending)→ stale toast,不重复加预算', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-revisit-grant-'));
    const runId = 'rg-260608-0002';
    const runDir = seed(base, runId);
    const driveRun = vi.fn();
    await handleV3RevisitGrantAction(value(runId), 'ou_op', { baseDir: base, driveRun });
    const res: any = await handleV3RevisitGrantAction(value(runId), 'ou_op', { baseDir: base, driveRun });
    expect(res.toast.type).toBe('warning');
    expect(readJournal(join(runDir, 'journal.ndjson')).filter((e) => e.type === 'revisitBudgetGranted')).toHaveLength(1);
    rmSync(base, { recursive: true, force: true });
  });

  it('nonce 不匹配 / 非法 runId / 无权限 → toast 不动 journal', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-revisit-grant-'));
    const runId = 'rg-260608-0003';
    const runDir = seed(base, runId);
    const driveRun = vi.fn();

    const badNonce: any = await handleV3RevisitGrantAction({ ...value(runId), nonce: 'wrong' }, 'ou_op', { baseDir: base, driveRun });
    expect(badNonce.toast.type).toBe('warning');

    const badId: any = await handleV3RevisitGrantAction({ ...value(runId), runId: '../escape' }, 'ou_op', { baseDir: base, driveRun });
    expect(badId.toast.type).toBe('warning');

    const denied: any = await handleV3RevisitGrantAction(value(runId), 'ou_op', { baseDir: base, driveRun, canResolve: () => false });
    expect(denied.toast.content).toContain('权限');
    expect(driveRun).not.toHaveBeenCalled();
    expect(readJournal(join(runDir, 'journal.ndjson')).some((e) => e.type === 'revisitBudgetGranted')).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  it('stale attempt:旧卡 attemptId 对不上当前 blocked attempt → 失效', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-revisit-grant-'));
    const runId = 'rg-260608-0004';
    const runDir = seed(base, runId);
    const driveRun = vi.fn();
    // 旧卡指向 attempts/000(对不上当前 blocked 的 attempts/001)
    const res: any = await handleV3RevisitGrantAction(value(runId, 'C#002/attempts/000'), 'ou_op', { baseDir: base, driveRun });
    expect(res.toast.type).toBe('warning');
    expect(driveRun).not.toHaveBeenCalled();
    expect(readJournal(join(runDir, 'journal.ndjson')).some((e) => e.type === 'revisitBudgetGranted')).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});
