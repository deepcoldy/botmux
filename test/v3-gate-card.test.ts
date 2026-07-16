import { describe, it, expect } from 'vitest';
import {
  buildV3GateCard,
  v3GateCardNonce,
  V3_GATE_APPROVE_ACTION,
  V3_GATE_REJECT_ACTION,
} from '../src/im/lark/v3-gate-card.js';
import { composeV3HostGatePrompt } from '../src/workflows/v3/host-bindings.js';

function parse(card: string): any {
  return JSON.parse(card);
}

/** collect all button `value` objects in the card. */
function buttonValues(card: any): any[] {
  const out: any[] = [];
  for (const el of card.elements ?? []) {
    if (el.tag === 'action') {
      for (const a of el.actions ?? []) {
        if (a.value) out.push(a.value);
      }
    }
  }
  return out;
}

describe('v3-gate-card — buildV3GateCard', () => {
  const base = { runId: 'demo-260603-1700', waitId: 'send-gate', nodeId: 'send', prompt: '要对外发送，批准？' };

  it('pending 卡：blue header + 通过/拒绝按钮带 {action,runId,waitId,nonce}', () => {
    const card = parse(buildV3GateCard(base));
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toContain('需要审批');
    const vals = buttonValues(card);
    const approve = vals.find((v) => v.action === V3_GATE_APPROVE_ACTION);
    const reject = vals.find((v) => v.action === V3_GATE_REJECT_ACTION);
    expect(approve).toEqual({
      action: V3_GATE_APPROVE_ACTION, runId: base.runId, waitId: base.waitId, nodeId: base.nodeId,
      nonce: v3GateCardNonce(base.runId, base.waitId), selected: 'approve',
    });
    expect(reject).toMatchObject({ action: V3_GATE_REJECT_ACTION, runId: base.runId, waitId: base.waitId, selected: 'reject' });
  });

  it('custom options：每个 option 渲染按钮，approveOptions 映射 primary/approve action', () => {
    const card = parse(buildV3GateCard({
      ...base,
      options: ['ship', 'hold', 'cancel'],
      approveOptions: ['ship'],
    }));
    const actionEl = card.elements.find((el: any) => el.tag === 'action' && el.actions?.some((a: any) => a.value?.selected === 'ship'));
    const buttons = actionEl.actions;
    expect(buttons.map((b: any) => b.value.selected)).toEqual(['ship', 'hold', 'cancel']);
    expect(buttons[0].type).toBe('primary');
    expect(buttons[0].value.action).toBe(V3_GATE_APPROVE_ACTION);
    expect(buttons[1].type).toBe('danger');
    expect(buttons[1].value.action).toBe(V3_GATE_REJECT_ACTION);
  });

  it('resolution=approved → green header、无 approve/reject 按钮（冻结防重复点）', () => {
    const card = parse(buildV3GateCard({ ...base, resolution: { kind: 'approved', by: 'ou_user' } }));
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toContain('已通过');
    const vals = buttonValues(card);
    expect(vals.some((v) => v.action === V3_GATE_APPROVE_ACTION || v.action === V3_GATE_REJECT_ACTION)).toBe(false);
  });

  it('resolution=rejected → red header + 已拒绝', () => {
    const card = parse(buildV3GateCard({ ...base, resolution: { kind: 'rejected' } }));
    expect(card.header.template).toBe('red');
    expect(card.header.title.content).toContain('已拒绝');
  });

  it('resolution 的 authored option 也只作为 plain_text 渲染', () => {
    const selected = '<at id=all></at>';
    const card = parse(buildV3GateCard({
      ...base,
      resolution: { kind: 'approved', selected },
    }));
    expect((card.elements as any[]).some(
      (el) => el.text?.tag === 'plain_text' && String(el.text.content).includes(selected),
    )).toBe(true);
    expect((card.elements as any[]).some(
      (el) => el.text?.tag === 'lark_md' && String(el.text.content).includes('<at id=all>'),
    )).toBe(false);
  });

  it('显式 nonce 透传到按钮 value', () => {
    const card = parse(buildV3GateCard({ ...base, nonce: 'custom-nonce' }));
    const approve = buttonValues(card).find((v) => v.action === V3_GATE_APPROVE_ACTION);
    expect(approve.nonce).toBe('custom-nonce');
  });

  it('prompt 作为 plain_text 渲染，Lark tag 不会在审批前触发通知', () => {
    const prompt = '危险 *bold* `code` [x] <at id=all></at>';
    const card = parse(buildV3GateCard({ ...base, prompt }));
    const promptDiv = (card.elements as any[]).find(
      (el) => el.tag === 'div' && el.text?.tag === 'plain_text' && el.text.content === prompt,
    );
    expect(promptDiv).toBeTruthy();
    expect((card.elements as any[]).some(
      (el) => el.text?.tag === 'lark_md' && String(el.text.content).includes('<at id=all>'),
    )).toBe(false);
  });

  it('host 长 prompt 也独立完整展示冻结 hash，并单独截断预览', () => {
    const inputHash = `sha256:${'a'.repeat(64)}`;
    const card = parse(buildV3GateCard({
      ...base,
      prompt: composeV3HostGatePrompt('很长'.repeat(400), [
        'Executor: feishu-send',
        `Frozen input hash: ${inputHash}`,
        '{"content":"hello"}',
      ].join('\n')),
      hostApproval: {
        attemptId: 'send#001/attempts/001',
        approvalDigest: `sha256:${'b'.repeat(64)}`,
        inputHash,
      },
    }));
    const rendered = JSON.stringify(card);
    expect(rendered).toContain(inputHash);
    expect(rendered).toContain('冻结输入 Hash（本次批准对象）');
    expect(rendered).toContain('Executor: feishu-send');
    expect(rendered).toContain('{\\"content\\":\\"hello\\"}');
    expect(rendered).toContain('截断，完整见 Web 详情');
  });

  it('host 冻结预览作为 plain_text 渲染，不把上游 Lark tag 当卡片语法', () => {
    const inputHash = `sha256:${'c'.repeat(64)}`;
    const maliciousPreview = '{"content":"<at id=all></at> 批准前不可通知"}';
    const card = parse(buildV3GateCard({
      ...base,
      prompt: composeV3HostGatePrompt('批准发送？', maliciousPreview),
      hostApproval: {
        attemptId: 'send#001/attempts/001',
        approvalDigest: `sha256:${'d'.repeat(64)}`,
        inputHash,
      },
    }));
    const previewDiv = (card.elements as any[]).find(
      (el) => el.text?.tag === 'plain_text' && String(el.text.content).includes(maliciousPreview),
    );
    expect(previewDiv).toBeTruthy();
    expect((card.elements as any[]).some(
      (el) => el.text?.tag === 'lark_md' && String(el.text.content).includes('<at id=all>'),
    )).toBe(false);
  });

  it('v3GateCardNonce 稳定（同 run+wait 一致）', () => {
    expect(v3GateCardNonce('r', 'w')).toBe(v3GateCardNonce('r', 'w'));
    expect(v3GateCardNonce('r', 'w')).not.toBe(v3GateCardNonce('r', 'w2'));
  });
});
