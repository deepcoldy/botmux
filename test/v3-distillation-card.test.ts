import { describe, expect, it } from 'vitest';

import {
  V3_DISTILL_ACCEPT_ACTION,
  V3_DISTILL_REJECT_ACTION,
  buildV3DistillationProposalCard,
  isV3DistillationAction,
  parseV3DistillationActionValue,
} from '../src/im/lark/v3-distillation-card.js';

const proposalId = `dp_${'a'.repeat(32)}`;
const nonce = 'b'.repeat(64);

describe('v3 parameter distillation proposal card', () => {
  it('renders only safe summaries and minimal callback values', () => {
    const card = JSON.parse(buildV3DistillationProposalCard({
      proposalId,
      nonce,
      parameters: [{
        name: 'city',
        type: 'string',
        required: true,
        hasDefault: false,
        replacementCount: 3,
        fieldCategories: [
          { category: 'goal', ordinal: 1 },
          { category: 'spec_narrative', ordinal: 2 },
        ],
      }],
    })) as Record<string, unknown>;
    const raw = JSON.stringify(card);

    expect(raw).toContain('city');
    expect(raw).toContain('替换 3 处');
    expect(raw).toContain('任务目标 #1');
    expect(raw).toContain('流程说明 #2');
    expect(raw).not.toMatch(/literal|hash|pointer|nodeId/);

    const actions = (card.elements as any[]).at(-1).actions as any[];
    expect(actions.map((button) => button.value)).toEqual([
      { action: V3_DISTILL_ACCEPT_ACTION, proposalId, nonce },
      { action: V3_DISTILL_REJECT_ACTION, proposalId, nonce },
    ]);
  });

  it('rejects extra or malformed summary fields before rendering', () => {
    const valid = {
      proposalId,
      nonce,
      parameters: [{
        name: 'city', type: 'string' as const, required: true as const, hasDefault: false as const,
        replacementCount: 1, fieldCategories: [{ category: 'goal' as const, ordinal: 1 }],
      }],
    };
    expect(() => buildV3DistillationProposalCard({
      ...valid,
      parameters: [{ ...valid.parameters[0], literal: 'private-value' } as any],
    })).toThrow(/参数摘要不合法/);
    expect(() => buildV3DistillationProposalCard({
      ...valid,
      parameters: [{ ...valid.parameters[0], fieldCategories: [{ category: 'goal', ordinal: 0 }] }],
    } as any)).toThrow(/字段摘要不合法/);
    expect(() => buildV3DistillationProposalCard({ ...valid, literal: 'private-value' } as any))
      .toThrow(/卡片输入不合法/);
  });

  it('copies each validated field once before rendering', () => {
    let reads = 0;
    const summary = {
      fieldCategories: [{ category: 'goal', ordinal: 1 }],
      hasDefault: false,
      get name() { reads++; return reads === 1 ? 'safe_name' : 'private_value'; },
      replacementCount: 1,
      required: true,
      type: 'string',
    };
    const raw = buildV3DistillationProposalCard({ proposalId, nonce, parameters: [summary] } as any);
    expect(reads).toBe(1);
    expect(raw).toContain('safe_name');
    expect(raw).not.toContain('private_value');
  });

  it('strictly parses exact callback values', () => {
    const accepted = { action: V3_DISTILL_ACCEPT_ACTION, proposalId, nonce };
    expect(parseV3DistillationActionValue(accepted)).toEqual(accepted);
    expect(parseV3DistillationActionValue({
      action: V3_DISTILL_REJECT_ACTION, proposalId, nonce,
    })).toEqual({ action: V3_DISTILL_REJECT_ACTION, proposalId, nonce });

    expect(parseV3DistillationActionValue({ ...accepted, runId: 'must-not-cross-card-boundary' })).toBeNull();
    expect(parseV3DistillationActionValue({ ...accepted, proposalId: `dp_${'g'.repeat(32)}` })).toBeNull();
    expect(parseV3DistillationActionValue({ ...accepted, nonce: 'b'.repeat(63) })).toBeNull();
    expect(parseV3DistillationActionValue(null)).toBeNull();
    expect(isV3DistillationAction(V3_DISTILL_ACCEPT_ACTION)).toBe(true);
    expect(isV3DistillationAction('v3_distill_future')).toBe(false);
  });
});
