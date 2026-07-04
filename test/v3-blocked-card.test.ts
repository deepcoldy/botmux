/**
 * v3-blocked-card(.handler).test.ts — blocked 重试卡构建 + 点击处理。
 * 镜像 v3-gate-card 系测试：卡片纯函数断言 + handler 的注入 seam 测试。
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildV3BlockedCard,
  v3BlockedCardNonce,
  V3_BLOCKED_RETRY_ACTION,
  V3_BLOCKED_ASK_ANSWER_ACTION,
  V3_BLOCKED_ASK_TEXT_FIELD,
  type V3BlockedActionValue,
  type V3AskAnswerActionValue,
} from '../src/im/lark/v3-blocked-card.js';
import { handleV3BlockedAction } from '../src/im/lark/v3-blocked-card-handler.js';
import { birthRun, readGrillState, writeGrillState } from '../src/workflows/v3/grill-state.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { ASK_HUMAN_ERROR_CODE, GOAL_ANSWER_FILE } from '../src/workflows/v3/contract.js';

const INPUT = {
  runId: 'demo-run-260606-1200',
  nodeId: 'deploy',
  attemptId: 'deploy/attempts/001',
  errorClass: 'workerError',
  errorCode: 'AUTH_REQUIRED',
  message: '需要登录 gcloud',
};

describe('buildV3BlockedCard', () => {
  it('pending 卡：orange header + 重试按钮 value 带 action/runId/nodeId/attemptId/nonce', () => {
    const card = JSON.parse(buildV3BlockedCard(INPUT));
    expect(card.header.template).toBe('orange');
    expect(card.header.title.content).toContain('deploy');
    // errorCode 在卡里（lark_md 转义会给 `_` 加反斜杠，按解析后的 content 断言）
    const reason = card.elements.find((e: any) => e.tag === 'div' && e.text?.content?.includes('原因'));
    expect(reason.text.content).toContain('AUTH\\_REQUIRED');
    const actionEl = card.elements.find((e: any) => e.tag === 'action' && e.actions[0]?.value);
    const value = actionEl.actions[0].value as V3BlockedActionValue;
    expect(value).toMatchObject({
      action: V3_BLOCKED_RETRY_ACTION,
      runId: INPUT.runId,
      nodeId: 'deploy',
      attemptId: 'deploy/attempts/001',
      nonce: v3BlockedCardNonce(INPUT.runId, 'deploy', 'deploy/attempts/001'),
    });
  });

  it('retried 冻结卡：green + 无重试按钮 + 显示新 attempt', () => {
    const card = JSON.parse(buildV3BlockedCard({ ...INPUT, retried: { nextAttemptId: 'deploy/attempts/002', by: 'ou_x' } }));
    expect(card.header.template).toBe('green');
    const json = JSON.stringify(card);
    expect(json).toContain('002');
    expect(json).not.toContain(V3_BLOCKED_RETRY_ACTION);
  });

  it('message 注入安全：lark_md 特殊字符被转义', () => {
    const card = buildV3BlockedCard({ ...INPUT, message: '*bold* [link](x)' });
    const parsed = JSON.parse(card);
    const reason = parsed.elements.find((e: any) => e.tag === 'div' && e.text?.content?.includes('原因'));
    expect(reason.text.content).toContain('\\*bold\\*');
  });

  it('ask 卡：blue header + 问题 + 每个选项一个按钮（value 带 selected + ask-answer action）', () => {
    const card = JSON.parse(buildV3BlockedCard({
      ...INPUT,
      ask: { question: '部署到哪个环境？', options: ['staging', 'prod'] },
    }));
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toContain('拍板');
    // 问题文案在卡里
    expect(JSON.stringify(card)).toContain('部署到哪个环境');
    // 一个选项一个按钮，value 带 selected
    const actionEl = card.elements.find(
      (e: any) => e.tag === 'action' && e.actions[0]?.value?.action === V3_BLOCKED_ASK_ANSWER_ACTION,
    );
    expect(actionEl.actions).toHaveLength(2);
    const v0 = actionEl.actions[0].value as V3AskAnswerActionValue;
    expect(v0).toMatchObject({
      action: V3_BLOCKED_ASK_ANSWER_ACTION,
      runId: INPUT.runId,
      nodeId: 'deploy',
      attemptId: 'deploy/attempts/001',
      selected: 'staging',
      nonce: v3BlockedCardNonce(INPUT.runId, 'deploy', 'deploy/attempts/001'),
    });
    expect((actionEl.actions[1].value as V3AskAnswerActionValue).selected).toBe('prod');
    // 没有普通重试按钮
    expect(JSON.stringify(card)).not.toContain(V3_BLOCKED_RETRY_ACTION);
  });

  it('ask 自由文本卡：blue header + 输入框 + 提交按钮（value 不携带文本）', () => {
    const card = JSON.parse(buildV3BlockedCard({
      ...INPUT,
      ask: { question: '请补充计费规则', freeText: true },
    }));
    expect(card.header.template).toBe('blue');
    expect(JSON.stringify(card)).toContain('请补充计费规则');
    const formEl = card.elements.find((e: any) => e.tag === 'form');
    expect(formEl.elements.find((e: any) => e.tag === 'input').name).toBe(V3_BLOCKED_ASK_TEXT_FIELD);
    const submit = formEl.elements.find((e: any) => e.tag === 'button');
    const value = submit.value as V3AskAnswerActionValue;
    expect(value).toMatchObject({
      action: V3_BLOCKED_ASK_ANSWER_ACTION,
      runId: INPUT.runId,
      nodeId: 'deploy',
      attemptId: 'deploy/attempts/001',
      answerKind: 'text',
      nonce: v3BlockedCardNonce(INPUT.runId, 'deploy', 'deploy/attempts/001'),
    });
    expect(JSON.stringify(value)).not.toContain('计费');
    expect(JSON.stringify(card)).not.toContain(V3_BLOCKED_RETRY_ACTION);
  });

  it('answered 冻结卡：green + 无选项按钮 + 显示选中项与新 attempt', () => {
    const card = JSON.parse(buildV3BlockedCard({
      ...INPUT,
      ask: { question: '部署到哪个环境？', options: ['staging', 'prod'] },
      answered: { selected: 'prod', nextAttemptId: 'deploy/attempts/002', by: 'ou_x' },
    }));
    expect(card.header.template).toBe('green');
    const json = JSON.stringify(card);
    expect(json).toContain('prod');
    expect(json).toContain('002');
    expect(json).not.toContain(V3_BLOCKED_ASK_ANSWER_ACTION);
  });

  it('answered 自由文本冻结卡：green + 显示文本预览与新 attempt', () => {
    const card = JSON.parse(buildV3BlockedCard({
      ...INPUT,
      ask: { question: '请补充计费规则', freeText: true },
      answered: { text: '超过 30 天按自然月计费', nextAttemptId: 'deploy/attempts/002', by: 'ou_x' },
    }));
    expect(card.header.template).toBe('green');
    const json = JSON.stringify(card);
    expect(json).toContain('超过 30 天');
    expect(json).toContain('002');
    expect(json).not.toContain(V3_BLOCKED_ASK_ANSWER_ACTION);
  });
});

describe('handleV3BlockedAction', () => {
  function seed(base: string, runId: string): string {
    const { runDir } = birthRun({
      goal: 'g', baseDir: base, runId,
      chatBinding: { larkAppId: 'cli_test', chatId: 'oc_chat', rootMessageId: 'om_root' },
    });
    const journalPath = join(runDir, 'journal.ndjson');
    appendEvent(journalPath, { type: 'runStarted', runId });
    appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'deploy', attemptId: 'deploy/attempts/001' });
    appendEvent(journalPath, {
      type: 'nodeBlocked', nodeId: 'deploy', attemptId: 'deploy/attempts/001',
      errorClass: 'workerError', errorCode: 'AUTH_REQUIRED', message: 'auth',
    });
    appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'deploy' });
    return runDir;
  }

  const value = (runId: string): V3BlockedActionValue => ({
    action: V3_BLOCKED_RETRY_ACTION,
    runId,
    nodeId: 'deploy',
    attemptId: 'deploy/attempts/001',
    nonce: v3BlockedCardNonce(runId, 'deploy', 'deploy/attempts/001'),
  });

  it('点击 → retry append + driveRun + 冻结「已重试」卡', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-blocked-card-'));
    const runId = 'click-260606-0001';
    seed(base, runId);
    const driveRun = vi.fn();
    const res: any = await handleV3BlockedAction(value(runId), 'ou_op', { baseDir: base, driveRun });
    expect(driveRun).toHaveBeenCalledWith(runId);
    expect(res.header.template).toBe('green');
    expect(JSON.stringify(res)).toContain('002');
    rmSync(base, { recursive: true, force: true });
  });

  it('二次点击（预留未消费）→ already toast + 仍 driveRun 兜底', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-blocked-card-'));
    const runId = 'click-260606-0002';
    seed(base, runId);
    const driveRun = vi.fn();
    await handleV3BlockedAction(value(runId), 'ou_op', { baseDir: base, driveRun });
    const res: any = await handleV3BlockedAction(value(runId), 'ou_op', { baseDir: base, driveRun });
    expect(res.toast.content).toContain('已在重试中');
    expect(driveRun).toHaveBeenCalledTimes(2);
    rmSync(base, { recursive: true, force: true });
  });

  it('nonce 不匹配 / 非法 runId / 无权限 → toast 不动 journal', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-blocked-card-'));
    const runId = 'click-260606-0003';
    seed(base, runId);
    const driveRun = vi.fn();

    const badNonce: any = await handleV3BlockedAction({ ...value(runId), nonce: 'wrong' }, 'ou_op', { baseDir: base, driveRun });
    expect(badNonce.toast.type).toBe('warning');

    const badId: any = await handleV3BlockedAction({ ...value(runId), runId: '../escape' }, 'ou_op', { baseDir: base, driveRun });
    expect(badId.toast.type).toBe('warning');

    const denied: any = await handleV3BlockedAction(value(runId), 'ou_op', {
      baseDir: base, driveRun, canResolve: () => false,
    });
    expect(denied.toast.content).toContain('权限');
    expect(driveRun).not.toHaveBeenCalled();
    rmSync(base, { recursive: true, force: true });
  });

  it('ask 选项点击 → 写 answer.json + nodeRetryRequested.answer + 冻结「已回答」卡 + driveRun', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-blocked-card-'));
    const runId = 'ask-260606-0001';
    const { runDir } = birthRun({
      goal: 'g', baseDir: base, runId,
      chatBinding: { larkAppId: 'cli_test', chatId: 'oc_chat', rootMessageId: 'om_root' },
    });
    const journalPath = join(runDir, 'journal.ndjson');
    // 受阻的那个 attempt 一定跑过（它写了 ask.json），目录存在 → answer.json 能落它旁边
    mkdirSync(join(runDir, 'deploy', 'attempts', '001'), { recursive: true });
    appendEvent(journalPath, { type: 'runStarted', runId });
    appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'deploy', attemptId: 'deploy/attempts/001' });
    appendEvent(journalPath, {
      type: 'nodeBlocked', nodeId: 'deploy', attemptId: 'deploy/attempts/001',
      errorClass: 'manifestInvalid', errorCode: ASK_HUMAN_ERROR_CODE, message: '部署到哪个环境？',
      ask: { question: '部署到哪个环境？', options: ['staging', 'prod'] },
    });
    appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'deploy' });

    const askValue: V3AskAnswerActionValue = {
      action: V3_BLOCKED_ASK_ANSWER_ACTION,
      runId, nodeId: 'deploy', attemptId: 'deploy/attempts/001',
      selected: 'prod',
      nonce: v3BlockedCardNonce(runId, 'deploy', 'deploy/attempts/001'),
    };
    const driveRun = vi.fn();
    const res: any = await handleV3BlockedAction(askValue, 'ou_op', { baseDir: base, driveRun });

    // 冻结绿卡，显示选中项
    expect(driveRun).toHaveBeenCalledWith(runId);
    expect(res.header.template).toBe('green');
    expect(JSON.stringify(res)).toContain('prod');

    // answer.json 落在受阻 attempt 旁边
    const answer = JSON.parse(readFileSync(join(runDir, 'deploy', 'attempts', '001', GOAL_ANSWER_FILE), 'utf-8'));
    expect(answer).toMatchObject({ selected: 'prod', by: 'ou_op' });

    // 重试事件带 answer 指针
    const retryEvt: any = readJournal(journalPath).find((e) => e.type === 'nodeRetryRequested');
    expect(retryEvt.answer).toMatchObject({ preview: 'prod', by: 'ou_op' });
    rmSync(base, { recursive: true, force: true });
  });

  it('ask 自由文本提交 → 原子写 answer.json + nodeRetryRequested.answer + 冻结「已回答」卡 + driveRun', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-blocked-card-'));
    const runId = 'ask-260606-0002';
    const { runDir } = birthRun({
      goal: 'g', baseDir: base, runId,
      chatBinding: { larkAppId: 'cli_test', chatId: 'oc_chat', rootMessageId: 'om_root' },
    });
    const journalPath = join(runDir, 'journal.ndjson');
    mkdirSync(join(runDir, 'deploy', 'attempts', '001'), { recursive: true });
    appendEvent(journalPath, { type: 'runStarted', runId });
    appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'deploy', attemptId: 'deploy/attempts/001' });
    appendEvent(journalPath, {
      type: 'nodeBlocked', nodeId: 'deploy', attemptId: 'deploy/attempts/001',
      errorClass: 'manifestInvalid', errorCode: ASK_HUMAN_ERROR_CODE, message: '请补充计费规则',
      ask: { question: '请补充计费规则', freeText: true },
    });
    appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'deploy' });

    const askValue: V3AskAnswerActionValue = {
      action: V3_BLOCKED_ASK_ANSWER_ACTION,
      runId, nodeId: 'deploy', attemptId: 'deploy/attempts/001',
      answerKind: 'text',
      nonce: v3BlockedCardNonce(runId, 'deploy', 'deploy/attempts/001'),
    };
    const longAnswer = `超过 30 天按自然月计费。${'计费边界说明'.repeat(40)}`;
    const driveRun = vi.fn();
    const res: any = await handleV3BlockedAction(
      askValue,
      'ou_op',
      { baseDir: base, driveRun },
      { [V3_BLOCKED_ASK_TEXT_FIELD]: longAnswer },
    );

    expect(driveRun).toHaveBeenCalledWith(runId);
    expect(res.header.template).toBe('green');
    expect(JSON.stringify(res)).toContain('超过 30 天');

    const answerPath = join(runDir, 'deploy', 'attempts', '001', GOAL_ANSWER_FILE);
    const answer = JSON.parse(readFileSync(answerPath, 'utf-8'));
    expect(answer).toMatchObject({ text: longAnswer, by: 'ou_op' });

    const retryEvt: any = readJournal(journalPath).find((e) => e.type === 'nodeRetryRequested');
    expect(retryEvt.answer.by).toBe('ou_op');
    expect(retryEvt.answer.preview).toContain('超过 30 天');
    expect(retryEvt.answer.preview.length).toBeLessThan(longAnswer.length);
    expect(retryEvt.answer.preview.length).toBeLessThanOrEqual(203);
    rmSync(base, { recursive: true, force: true });
  });

  it('run 已不在 blocked（如已重跑成功）→ stale toast', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-blocked-card-'));
    const runId = 'click-260606-0004';
    const runDir = seed(base, runId);
    const journalPath = join(runDir, 'journal.ndjson');
    appendEvent(journalPath, {
      type: 'nodeRetryRequested', nodeId: 'deploy',
      previousAttemptId: 'deploy/attempts/001', nextAttemptId: 'deploy/attempts/002', reason: 'blockedRetry',
    });
    appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'deploy', attemptId: 'deploy/attempts/002' });
    appendEvent(journalPath, { type: 'nodeSucceeded', nodeId: 'deploy', attemptId: 'deploy/attempts/002', manifestPath: join(runDir, 'm.json') });
    appendEvent(journalPath, { type: 'runSucceeded' });

    const driveRun = vi.fn();
    const res: any = await handleV3BlockedAction(value(runId), 'ou_op', { baseDir: base, driveRun });
    expect(res.toast.type).toBe('warning');
    expect(driveRun).not.toHaveBeenCalled();
    rmSync(base, { recursive: true, force: true });
  });
});
