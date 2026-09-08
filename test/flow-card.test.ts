import { describe, expect, it } from 'vitest';
import {
  FLOW_CANCEL_ACTION,
  FLOW_DECIDE_ACTION,
  FLOW_DECIDE_RUN_ACTION,
  FLOW_RESEND_ACTION,
  FLOW_RESUME_ACTION,
  FLOW_SIGNAL_ACTION,
  FLOW_SIGNAL_FIELD_PREFIX,
  FLOW_SIGNAL_JSON_FIELD,
  buildFlowDecisionCard,
  buildFlowInterruptedCard,
  buildFlowProgressCard,
  buildFlowRunPauseCard,
  buildFlowSignalCard,
  flowCardNonce,
  isFlowCardAction,
  signalFormShape,
  signalPayloadFromForm,
} from '../src/im/lark/flow-card.js';
import type { OpenWait, PendingDecision, RunSnapshot } from '../src/flow/types.js';

function snapshot(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: 'r1',
    gen: 1,
    status: 'running',
    health: 'ok',
    counts: { started: 2, ok: 1, failed: 0, inflight: 1 },
    attempts: [
      { identity: 'gen#1', attempt: 1, state: 'result', phase: null, cli: 'codex' },
      { identity: 'gen#2', attempt: 1, state: 'inflight', phase: 'sent', cli: 'codex' },
    ] as RunSnapshot['attempts'],
    pending: [],
    runPause: null,
    waits: [],
    notes: ['first note'],
    finished: null,
    error: null,
    activeMs: 12_000,
    updatedAt: Date.now(),
    ...over,
  };
}

function wait(over: Partial<OpenWait> = {}): OpenWait {
  return { identity: 'pick#1', version: 1, content: 'c1', prompt: 'choose <at id=all>', schema: null, delivery: 'pending', messageId: null, deliveryError: null, openedAt: 1, timeoutAt: 2, ...over };
}

const decision: PendingDecision = {
  identity: 'gen#3',
  content: 'c3',
  attempt: 2,
  outcome: { ok: false, identity: 'gen#3', attempt: 2, category: 'cli_error', retry: 'manual', effects: 'unknown', error: 'boom', evidence: {} } as PendingDecision['outcome'],
  reason: 'uncertain',
};

function buttons(cardJson: string): Array<Record<string, unknown>> {
  const card = JSON.parse(cardJson) as { elements: Array<Record<string, unknown>> };
  const out: Array<Record<string, unknown>> = [];
  const visit = (els: Array<Record<string, unknown>>): void => {
    for (const el of els) {
      if (el.tag === 'button') out.push(el);
      if (Array.isArray(el.actions)) visit(el.actions as Array<Record<string, unknown>>);
      if (Array.isArray(el.elements)) visit(el.elements as Array<Record<string, unknown>>);
    }
  };
  visit(card.elements);
  return out;
}

function values(cardJson: string): Array<Record<string, unknown>> {
  return buttons(cardJson).map((b) => b.value as Record<string, unknown>);
}

describe('flow card builders', () => {
  it('isFlowCardAction 只认 flow_ 命名空间', () => {
    for (const a of [FLOW_CANCEL_ACTION, FLOW_DECIDE_ACTION, FLOW_DECIDE_RUN_ACTION, FLOW_SIGNAL_ACTION, FLOW_RESEND_ACTION, FLOW_RESUME_ACTION]) expect(isFlowCardAction(a)).toBe(true);
    expect(isFlowCardAction('wf_approve')).toBe(false);
    expect(isFlowCardAction(undefined)).toBe(false);
  });

  it('进度卡：运行中带取消按钮（nonce 可复现），结束 / 中断后没有', () => {
    const running = buildFlowProgressCard({ snapshot: snapshot(), scriptName: 'slogan.mjs' });
    expect(values(running)).toEqual([{ action: FLOW_CANCEL_ACTION, runId: 'r1', nonce: flowCardNonce('r1', 'cancel', '') }]);
    expect(running).toContain('first note');
    const done = buildFlowProgressCard({ snapshot: snapshot({ status: 'completed', finished: { status: 'completed', health: 'ok', replay: 'none', returned: { a: 1 } } }), scriptName: 'slogan.mjs' });
    expect(buttons(done)).toHaveLength(0);
    expect(done).toContain('完成');
    const interrupted = buildFlowProgressCard({ snapshot: snapshot(), scriptName: 'slogan.mjs', interrupted: { reason: 'daemon_disconnect' } });
    expect(buttons(interrupted)).toHaveLength(0);
    expect(interrupted).toContain('daemon_disconnect');
  });

  it('决策卡：两个按钮带 identity/attempt/content 与 nonce；冻结后无按钮', () => {
    const open = buildFlowDecisionCard({ runId: 'r1', decision });
    const vs = values(open);
    expect(vs.map((v) => v.choice)).toEqual(['accept-failed', 'retry']);
    for (const v of vs) expect(v).toMatchObject({ action: FLOW_DECIDE_ACTION, runId: 'r1', identity: 'gen#3', attempt: 2, content: 'c3', nonce: flowCardNonce('r1', 'decide', 'gen#3#2') });
    const frozen = buildFlowDecisionCard({ runId: 'r1', decision, resolution: { choice: 'retry', by: 'ou_x' } });
    expect(buttons(frozen)).toHaveLength(0);
    expect(frozen).toContain('重试一次');
  });

  it('run 级暂停卡：journal_integrity → accept-journal；其它 → assume-clean', () => {
    const j = values(buildFlowRunPauseCard({ runId: 'r1', gen: 2, pause: { reason: 'journal_integrity', detail: 'x' } }));
    expect(j.map((v) => v.choice)).toEqual(['accept-journal', 'cancel']);
    expect(j[0]!.nonce).toBe(flowCardNonce('r1', 'pause', '2'));
    const e = values(buildFlowRunPauseCard({ runId: 'r1', gen: 2, pause: { reason: 'escape', detail: 'x' } }));
    expect(e.map((v) => v.choice)).toEqual(['assume-clean', 'cancel']);
  });

  it('中断卡：恢复 / 取消带 gen；冻结后无按钮', () => {
    const open = buildFlowInterruptedCard({ runId: 'r1', gen: 3, scriptName: 's.mjs', reason: 'daemon_disconnect', inflight: ['a#1'] });
    expect(values(open)).toEqual([
      { action: FLOW_RESUME_ACTION, runId: 'r1', gen: 3, choice: 'resume', nonce: flowCardNonce('r1', 'interrupted', '3'), key: 'resume' },
      { action: FLOW_RESUME_ACTION, runId: 'r1', gen: 3, choice: 'cancel', nonce: flowCardNonce('r1', 'interrupted', '3'), key: 'cancel' },
    ]);
    expect(open).toContain('a#1');
    expect(buttons(buildFlowInterruptedCard({ runId: 'r1', gen: 3, scriptName: 's.mjs', reason: 'x', inflight: [], resolution: { choice: 'stale' } }))).toHaveLength(0);
  });
});

describe('signal card form shapes', () => {
  it('裸 enum → 按钮，每个按钮的 choice 是 JSON 编码的选项', () => {
    const card = buildFlowSignalCard({ runId: 'r1', wait: wait({ schema: { enum: ['a', 'b'] } }) });
    const vs = values(card).filter((v) => v.action === FLOW_SIGNAL_ACTION);
    expect(vs.map((v) => v.choice)).toEqual(['"a"', '"b"']);
    expect(vs[0]).toMatchObject({ runId: 'r1', identity: 'pick#1', version: 1, nonce: flowCardNonce('r1', 'signal', 'pick#1:1') });
    // prompt 用 plain_text 渲染：不可信文本里的 <at> 原样保留在 plain_text 里，不进 lark_md
    const parsed = JSON.parse(card) as { elements: Array<{ tag: string; text?: { tag: string; content: string } }> };
    const promptEl = parsed.elements.find((e) => e.text?.content.includes('<at id=all>'));
    expect(promptEl?.text?.tag).toBe('plain_text');
    // 重发按钮
    expect(values(card).some((v) => v.action === FLOW_RESEND_ACTION)).toBe(true);
  });

  it('单属性 enum 对象 → 按钮带 field', () => {
    const shape = signalFormShape({ type: 'object', properties: { choice: { enum: ['x', 'y'] } }, required: ['choice'] });
    expect(shape).toEqual({ kind: 'enum', enumField: 'choice', enumValues: ['x', 'y'] });
    const card = buildFlowSignalCard({ runId: 'r1', wait: wait({ schema: { type: 'object', properties: { choice: { enum: ['x', 'y'] } } } }) });
    expect(values(card).filter((v) => v.action === FLOW_SIGNAL_ACTION).map((v) => v.field)).toEqual(['choice', 'choice']);
  });

  it('扁平对象 → 每属性一个 input；复杂 schema → 单个 JSON input', () => {
    const flat = buildFlowSignalCard({ runId: 'r1', wait: wait({ schema: { type: 'object', properties: { name: { type: 'string' }, n: { type: 'integer' } }, required: ['name'] } }) });
    const inputs = (JSON.parse(flat) as { elements: Array<{ tag: string; elements?: Array<{ tag: string; name?: string; action_type?: string }> }> }).elements.find((e) => e.tag === 'form')!.elements!;
    expect(inputs.filter((e) => e.tag === 'input').map((e) => e.name)).toEqual([`${FLOW_SIGNAL_FIELD_PREFIX}name`, `${FLOW_SIGNAL_FIELD_PREFIX}n`]);
    expect(inputs.find((e) => e.tag === 'button')?.action_type).toBe('form_submit');
    expect(signalFormShape({ type: 'object', properties: { items: { type: 'array' } } })).toEqual({ kind: 'json' });
    expect(signalFormShape({ enum: Array.from({ length: 9 }, (_, i) => i) })).toEqual({ kind: 'json' });
    const json = buildFlowSignalCard({ runId: 'r1', wait: wait({ schema: { type: 'array' } }) });
    expect(json).toContain(FLOW_SIGNAL_JSON_FIELD);
  });

  it('冻结卡：consumed 回显值，superseded 指向新版本，无表单', () => {
    const consumed = buildFlowSignalCard({ runId: 'r1', wait: wait(), resolution: { how: 'consumed', by: 'ou_x', value: { choice: 'b' } } });
    expect(buttons(consumed)).toHaveLength(0);
    const texts = (JSON.parse(consumed) as { elements: Array<{ text?: { content: string } }> }).elements.map((e) => e.text?.content ?? '');
    expect(texts.some((t) => t.includes('{"choice":"b"}') && t.includes('ou_x'))).toBe(true);
    const superseded = buildFlowSignalCard({ runId: 'r1', wait: wait(), resolution: { how: 'superseded', newVersion: 2 } });
    expect(superseded).toContain('v2');
  });
});

describe('signalPayloadFromForm', () => {
  it('按钮选项：裸 enum 直接是值；对象 enum 包成 {field: 值}', () => {
    expect(signalPayloadFromForm({ enum: ['a'] }, undefined, { choice: '"a"' })).toEqual({ ok: true, value: 'a' });
    expect(signalPayloadFromForm({ enum: [1] }, undefined, { choice: '1' })).toEqual({ ok: true, value: 1 });
    expect(signalPayloadFromForm({}, undefined, { field: 'choice', choice: '"b"' })).toEqual({ ok: true, value: { choice: 'b' } });
    expect(signalPayloadFromForm({}, undefined, { choice: 'not json' })).toMatchObject({ ok: false });
  });

  it('扁平字段：按类型还原，必填缺失报错，enum 属性校验取值', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' }, n: { type: 'integer' }, ok: { type: 'boolean' }, mode: { enum: ['fast', 'slow'] } }, required: ['name'] };
    expect(signalPayloadFromForm(schema, { flow_f_name: ' x ', flow_f_n: '3', flow_f_ok: '是', flow_f_mode: 'slow' })).toEqual({ ok: true, value: { name: 'x', n: 3, ok: true, mode: 'slow' } });
    expect(signalPayloadFromForm(schema, { flow_f_name: 'x' })).toEqual({ ok: true, value: { name: 'x' } });
    expect(signalPayloadFromForm(schema, { flow_f_n: '3' })).toMatchObject({ ok: false, error: expect.stringContaining('name') });
    expect(signalPayloadFromForm(schema, { flow_f_name: 'x', flow_f_n: '3.5' })).toMatchObject({ ok: false, error: expect.stringContaining('n:') });
    expect(signalPayloadFromForm(schema, { flow_f_name: 'x', flow_f_mode: 'medium' })).toMatchObject({ ok: false });
  });

  it('JSON 兜底', () => {
    expect(signalPayloadFromForm({ type: 'array' }, { [FLOW_SIGNAL_JSON_FIELD]: '[1,2]' })).toEqual({ ok: true, value: [1, 2] });
    expect(signalPayloadFromForm({ type: 'array' }, { [FLOW_SIGNAL_JSON_FIELD]: '' })).toMatchObject({ ok: false });
    expect(signalPayloadFromForm(null, { [FLOW_SIGNAL_JSON_FIELD]: '{' })).toMatchObject({ ok: false });
  });
});
