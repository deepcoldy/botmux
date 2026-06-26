import { describe, it, expect } from 'vitest';
import {
  buildV3GateCard,
  v3GateCardNonce,
  V3_GATE_APPROVE_ACTION,
  V3_GATE_REJECT_ACTION,
} from '../src/im/lark/v3-gate-card.js';

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

  it('显式 nonce 透传到按钮 value', () => {
    const card = parse(buildV3GateCard({ ...base, nonce: 'custom-nonce' }));
    const approve = buttonValues(card).find((v) => v.action === V3_GATE_APPROVE_ACTION);
    expect(approve.nonce).toBe('custom-nonce');
  });

  it('prompt 里的 markdown 特殊字符被转义（防破坏卡结构）', () => {
    const card = parse(buildV3GateCard({ ...base, prompt: '危险 *bold* `code` [x]' }));
    // 找审批内容那个 div 的 content（JSON.parse 后是含字面反斜杠的转义文本）
    const promptDiv = (card.elements as any[]).find(
      (el) => el.tag === 'div' && typeof el.text?.content === 'string' && el.text.content.includes('审批内容'),
    );
    expect(promptDiv).toBeTruthy();
    expect(promptDiv.text.content).toContain('\\*bold\\*');
    expect(promptDiv.text.content).toContain('\\`code\\`');
  });

  it('v3GateCardNonce 稳定（同 run+wait 一致）', () => {
    expect(v3GateCardNonce('r', 'w')).toBe(v3GateCardNonce('r', 'w'));
    expect(v3GateCardNonce('r', 'w')).not.toBe(v3GateCardNonce('r', 'w2'));
  });
});
