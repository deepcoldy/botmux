import { describe, expect, it } from 'vitest';

import {
  V3HostBindingError,
  collectV3HostBindingRefs,
  parseV3HostBindingRef,
  renderV3HostInputPreview,
  resolveV3HostInputTemplate,
} from '../src/workflows/v3/host-bindings.js';

describe('v3 host bindings', () => {
  it('parses params/context/result refs without confusing dotted node ids', () => {
    expect(parseV3HostBindingRef('params.city')).toEqual({ kind: 'params', path: ['city'] });
    expect(parseV3HostBindingRef('context.chatId')).toEqual({ kind: 'context', path: ['chatId'] });
    expect(parseV3HostBindingRef('team.plan.result.message.text')).toEqual({
      kind: 'result', nodeId: 'team.plan', path: ['message', 'text'],
    });
  });

  it('resolves exact refs with type preservation and scalar string interpolation', async () => {
    const resultLoads: string[] = [];
    const resolved = await resolveV3HostInputTemplate({
      chatId: { $ref: 'context.chatId' },
      content: 'Plan for ${params.city}: ${plan.result.summary}',
      days: { $ref: 'params.days' },
      rows: { $ref: 'plan.result.rows' },
    }, {
      params: { city: 'Paris', days: 3 },
      context: { chatId: 'oc_1' },
      loadResult: async (nodeId) => {
        resultLoads.push(nodeId);
        return { summary: 'sunny', rows: [{ day: 1 }] };
      },
    });
    expect(resolved).toEqual({
      chatId: 'oc_1', content: 'Plan for Paris: sunny', days: 3, rows: [{ day: 1 }],
    });
    expect(resultLoads).toEqual(['plan']);
  });

  it('rejects object interpolation inside a string and points to exact $ref', async () => {
    await expect(resolveV3HostInputTemplate('payload=${plan.result.payload}', {
      params: {}, context: {}, loadResult: async () => ({ payload: { x: 1 } }),
    })).rejects.toThrow(/non-scalar; use exact \$ref/);
  });

  it('rejects malformed refs, proto paths, extra $ref keys, and non-JSON values', () => {
    expect(() => collectV3HostBindingRefs('${HOME}')).toThrow(V3HostBindingError);
    expect(() => collectV3HostBindingRefs({ $ref: 'params.__proto__' })).toThrow(/unsafe/);
    expect(() => collectV3HostBindingRefs({ $ref: 'params.x', fallback: 1 })).toThrow(/exact object/);
    expect(() => collectV3HostBindingRefs({ x: undefined })).toThrow(/finite JSON/);
  });

  it('redacts secret-looking fields and bounds long gate previews', () => {
    const preview = renderV3HostInputPreview('feishu-send', {
      token: 'dont-show', content: 'x'.repeat(2_000), nested: { password: 'dont-show-either' },
    }, 'sha256:abc');
    expect(preview).toContain('feishu-send');
    expect(preview).toContain('sha256:abc');
    expect(preview).toContain('[REDACTED]');
    expect(preview).not.toContain('dont-show');
    expect(preview.length).toBeLessThan(4_500);
  });
});
