/**
 * flow 卡片前置门（flow-card-handler.ts）：陌生人 / 坏 nonce / 旧 version / 已消费 / 中断态
 * 分别被拒或翻译成对应 toast；合法点击转成 runner 控制请求并返回冻结卡。
 */
import { describe, expect, it, vi } from 'vitest';
import { FLOW_CANCEL_ACTION, FLOW_DECIDE_ACTION, FLOW_RESEND_ACTION, FLOW_RESUME_ACTION, FLOW_SIGNAL_ACTION, flowCardNonce } from '../src/im/lark/flow-card.js';
import { handleFlowCardAction, type FlowCardHandlerDeps } from '../src/im/lark/flow-card-handler.js';
import type { ControlRequest, ControlResponse, OpenWait, PendingDecision, RunBinding } from '../src/flow/types.js';

const binding: RunBinding = { larkAppId: 'cli_a', chatId: 'oc_1', rootId: 'om_1', sessionId: 's1', ownerOpenId: 'ou_owner', triggeredBy: 'ou_owner', workingDir: '/tmp' };
const OWNER = 'ou_owner';
const STRANGER = 'ou_stranger';

function wait(over: Partial<OpenWait> = {}): OpenWait {
  return { identity: 'pick#1', version: 2, content: 'c', prompt: 'p', schema: { enum: ['a', 'b'] }, delivery: 'delivered', messageId: 'om_w', deliveryError: null, openedAt: 1, timeoutAt: 2, ...over };
}

const pending: PendingDecision = { identity: 'gen#1', content: 'c1', attempt: 1, outcome: { ok: false, identity: 'gen#1', attempt: 1, evidence: {}, error: 'x', category: 'cli_error', retry: 'manual', effects: 'unknown' }, reason: 'failed_manual' };

function okStatus(over: Partial<Extract<ControlResponse, { ok: true }>> = {}): ControlResponse {
  return { ok: true, status: 'paused', pending: [], waits: [], ...over };
}

function deps(over: Partial<FlowCardHandlerDeps> = {}, control?: (runId: string, req: ControlRequest) => Promise<ControlResponse | null>): FlowCardHandlerDeps & { calls: ControlRequest[] } {
  const calls: ControlRequest[] = [];
  return {
    calls,
    readBinding: (runId) => (runId === 'r1' ? binding : null),
    canOperate: (_b, openId) => openId === OWNER,
    control: async (runId, req) => {
      calls.push(req);
      return control ? control(runId, req) : okStatus();
    },
    resumeInterrupted: vi.fn(async () => null),
    interruptedGenIsCurrent: () => true,
    scriptName: () => 's.mjs',
    interruptedInfo: () => ({ reason: 'daemon_disconnect', inflight: [] }),
    lastRunPause: () => null,
    ...over,
  };
}

function toastOf(res: unknown): { type: string; content: string } {
  return (res as { toast: { type: string; content: string } }).toast;
}

describe('flow card front gate', () => {
  it('未知动作 / 非法 runId / 无操作者 / 不存在的 run 一律 toast 拒绝，不碰 runner', async () => {
    const d = deps();
    expect(toastOf(await handleFlowCardAction({ action: 'wf_approve' }, OWNER, undefined, d)).type).toBe('warning');
    expect(toastOf(await handleFlowCardAction({ action: FLOW_CANCEL_ACTION, runId: '../x', nonce: '' }, OWNER, undefined, d)).type).toBe('warning');
    expect(toastOf(await handleFlowCardAction({ action: FLOW_CANCEL_ACTION, runId: 'r1', nonce: flowCardNonce('r1', 'cancel', '') }, undefined, undefined, d)).type).toBe('error');
    expect(toastOf(await handleFlowCardAction({ action: FLOW_CANCEL_ACTION, runId: 'nope', nonce: flowCardNonce('nope', 'cancel', '') }, OWNER, undefined, d)).content).toContain('不存在');
    expect(d.calls).toHaveLength(0);
  });

  it('陌生人被 canOperate 拒绝', async () => {
    const d = deps();
    const res = await handleFlowCardAction({ action: FLOW_CANCEL_ACTION, runId: 'r1', nonce: flowCardNonce('r1', 'cancel', '') }, STRANGER, undefined, d);
    expect(toastOf(res).content).toContain('权限');
    expect(d.calls).toHaveLength(0);
  });

  it('nonce 串号（另一个 run 的卡）被拒', async () => {
    const d = deps();
    const res = await handleFlowCardAction({ action: FLOW_CANCEL_ACTION, runId: 'r1', nonce: flowCardNonce('r2', 'cancel', '') }, OWNER, undefined, d);
    expect(toastOf(res).content).toContain('nonce');
    expect(d.calls).toHaveLength(0);
  });

  it('取消：转发 cancel；runner 不在 → 提示先恢复', async () => {
    const d = deps();
    const res = await handleFlowCardAction({ action: FLOW_CANCEL_ACTION, runId: 'r1', nonce: flowCardNonce('r1', 'cancel', '') }, OWNER, undefined, d);
    expect(toastOf(res).type).toBe('success');
    expect(d.calls).toEqual([{ t: 'cancel', by: OWNER }]);
    const gone = deps({}, async () => null);
    expect(toastOf(await handleFlowCardAction({ action: FLOW_CANCEL_ACTION, runId: 'r1', nonce: flowCardNonce('r1', 'cancel', '') }, OWNER, undefined, gone)).content).toContain('中断');
  });

  it('决策：待决策存在 → decide 并返回冻结卡；已处理 → info toast', async () => {
    const value = { action: FLOW_DECIDE_ACTION, runId: 'r1', identity: 'gen#1', attempt: 1, content: 'c1', choice: 'retry', nonce: flowCardNonce('r1', 'decide', 'gen#1#1'), key: 'retry' };
    const d = deps({}, async (_r, req) => (req.t === 'status' ? okStatus({ pending: [pending] }) : okStatus()));
    const res = await handleFlowCardAction(value, OWNER, undefined, d);
    expect((res as { header: { title: { content: string } } }).header.title.content).toContain('已处理');
    expect(d.calls[1]).toEqual({ t: 'decide', identity: 'gen#1', content: 'c1', attempt: 1, choice: 'retry', by: OWNER });
    const stale = deps();
    expect(toastOf(await handleFlowCardAction(value, OWNER, undefined, stale)).type).toBe('info');
    // 坏 nonce
    expect(toastOf(await handleFlowCardAction({ ...value, nonce: 'x' }, OWNER, undefined, d)).content).toContain('nonce');
  });

  it('信号：按钮选项 → signal 请求带 wait.content 与还原后的 value，返回冻结卡', async () => {
    const w = wait();
    const d = deps({}, async (_r, req) => (req.t === 'status' ? okStatus({ waits: [w] }) : okStatus()));
    const value = { action: FLOW_SIGNAL_ACTION, runId: 'r1', identity: 'pick#1', version: 2, nonce: flowCardNonce('r1', 'signal', 'pick#1:2'), choice: '"b"' };
    const res = await handleFlowCardAction(value, OWNER, undefined, d);
    expect(d.calls[1]).toEqual({ t: 'signal', identity: 'pick#1', version: 2, content: 'c', by: OWNER, value: 'b' });
    expect((res as { header: { title: { content: string } } }).header.title.content).toContain('已提交');
  });

  it('信号：旧 version 的卡 → 过期 toast，不转发', async () => {
    const d = deps({}, async (_r, req) => (req.t === 'status' ? okStatus({ waits: [wait({ version: 3 })] }) : okStatus()));
    const value = { action: FLOW_SIGNAL_ACTION, runId: 'r1', identity: 'pick#1', version: 2, nonce: flowCardNonce('r1', 'signal', 'pick#1:2'), choice: '"b"' };
    const res = await handleFlowCardAction(value, OWNER, undefined, d);
    expect(toastOf(res).content).toContain('v3');
    expect(d.calls.map((c) => c.t)).toEqual(['status']);
  });

  it('信号：runner 裁决 consumed / stale_version / schema_mismatch 翻译成 toast', async () => {
    const w = wait();
    const value = { action: FLOW_SIGNAL_ACTION, runId: 'r1', identity: 'pick#1', version: 2, nonce: flowCardNonce('r1', 'signal', 'pick#1:2'), choice: '"b"' };
    for (const [code, expectType] of [['consumed', 'info'], ['stale_version', 'warning'], ['schema_mismatch', 'error']] as const) {
      const d = deps({}, async (_r, req) => (req.t === 'status' ? okStatus({ waits: [w] }) : { ok: false, error: `runner said ${code}`, code }));
      expect(toastOf(await handleFlowCardAction(value, OWNER, undefined, d)).type).toBe(expectType);
    }
    // 没有 open wait（已消费）→ info
    const none = deps();
    expect(toastOf(await handleFlowCardAction(value, OWNER, undefined, none)).type).toBe('info');
  });

  it('信号：表单提交按 schema 还原字段', async () => {
    const w = wait({ schema: { type: 'object', properties: { name: { type: 'string' }, n: { type: 'integer' } }, required: ['name'] } });
    const d = deps({}, async (_r, req) => (req.t === 'status' ? okStatus({ waits: [w] }) : okStatus()));
    const value = { action: FLOW_SIGNAL_ACTION, runId: 'r1', identity: 'pick#1', version: 2, nonce: flowCardNonce('r1', 'signal', 'pick#1:2') };
    await handleFlowCardAction(value, OWNER, { flow_f_name: 'x', flow_f_n: '4' }, d);
    expect(d.calls[1]).toMatchObject({ t: 'signal', value: { name: 'x', n: 4 } });
    const bad = deps({}, async (_r, req) => (req.t === 'status' ? okStatus({ waits: [w] }) : okStatus()));
    expect(toastOf(await handleFlowCardAction(value, OWNER, { flow_f_n: '4' }, bad)).type).toBe('error');
    expect(bad.calls.map((c) => c.t)).toEqual(['status']);
  });

  it('重发：转发 resend，toast 带新 version', async () => {
    const d = deps({}, async (_r, req) => (req.t === 'resend' ? okStatus({ waits: [wait({ version: 3, delivery: 'resent' })] }) : okStatus()));
    const res = await handleFlowCardAction({ action: FLOW_RESEND_ACTION, runId: 'r1', identity: 'pick#1', version: 2, nonce: flowCardNonce('r1', 'signal', 'pick#1:2') }, OWNER, undefined, d);
    expect(d.calls).toEqual([{ t: 'resend', identity: 'pick#1', by: OWNER }]);
    expect(toastOf(res).content).toContain('v3');
  });

  it('中断卡：gen 仍最新 → resumeInterrupted；已过期 → 冻结成 stale', async () => {
    const d = deps();
    const value = { action: FLOW_RESUME_ACTION, runId: 'r1', gen: 2, choice: 'resume', nonce: flowCardNonce('r1', 'interrupted', '2'), key: 'resume' };
    const res = await handleFlowCardAction(value, OWNER, undefined, d);
    expect(d.resumeInterrupted).toHaveBeenCalledWith('r1', OWNER, 'resume');
    expect((res as { header: { title: { content: string } } }).header.title.content).toContain('已处理');
    const stale = deps({ interruptedGenIsCurrent: () => false });
    const staleRes = await handleFlowCardAction(value, OWNER, undefined, stale);
    expect(stale.resumeInterrupted).not.toHaveBeenCalled();
    expect(JSON.stringify(staleRes)).toContain('已失效');
    const failing = deps({ resumeInterrupted: vi.fn(async () => '上限') });
    expect(toastOf(await handleFlowCardAction(value, OWNER, undefined, failing)).type).toBe('error');
  });
});
