import { describe, expect, it } from 'vitest';

import { assertSavedWorkflowTemplateBindings } from '../src/workflows/v3/template-bindings.js';

describe('Saved Workflow template binding policy', () => {
  it('rejects parameter markers in humanGate prompts', () => {
    expect(() => assertSavedWorkflowTemplateBindings({
      nodes: [{
        id: 'deploy',
        type: 'goal',
        goal: 'Prepare deployment for ${params.environment}',
        depends: [],
        inputs: [],
        humanGate: { prompt: 'Approve deployment to ${params.environment}?' },
      }],
    }, {
      environment: { type: 'string', required: true },
    }, [])).toThrow(/structural\/safety field dagTemplate\.nodes\[0\]\.humanGate\.prompt/);
  });

  it('continues to allow declared markers in worker-only goal text', () => {
    expect(() => assertSavedWorkflowTemplateBindings({
      nodes: [{
        id: 'report',
        type: 'goal',
        goal: 'Write ${params.topic} for ${context.chatId}',
        depends: [],
        inputs: [],
      }],
    }, {
      topic: { type: 'string', required: true },
    }, ['chatId'])).not.toThrow();
  });
});

describe('Saved Workflow botmux-schedule ownerOpenId binding policy', () => {
  const CONTEXT_REFS = ['larkAppId', 'chatId', 'chatType', 'initiatorOpenId'] as const;

  function scheduleDag(ownerOpenIdInput: unknown, includeOwner: boolean) {
    const input: Record<string, unknown> = {
      name: 'daily',
      schedule: '0 9 * * *',
      prompt: 'run it',
      workingDir: '/workspace',
      larkAppId: { $ref: 'context.larkAppId' },
      chatId: { $ref: 'context.chatId' },
      chatType: { $ref: 'context.chatType' },
    };
    if (includeOwner) input.ownerOpenId = ownerOpenIdInput;
    return {
      nodes: [{
        id: 's',
        type: 'host' as const,
        executor: 'botmux-schedule' as const,
        input,
        depends: [],
        inputs: [],
        humanGate: { prompt: 'Create this schedule?' },
      }],
    };
  }

  it('accepts the exact context.initiatorOpenId $ref when the context is declared', () => {
    expect(() => assertSavedWorkflowTemplateBindings(
      scheduleDag({ $ref: 'context.initiatorOpenId' }, true),
      {},
      CONTEXT_REFS,
    )).not.toThrow();
  });

  it('accepts an omitted ownerOpenId (ownerless / cross-app templates)', () => {
    expect(() => assertSavedWorkflowTemplateBindings(
      scheduleDag(undefined, false),
      {},
      ['larkAppId', 'chatId', 'chatType'],
    )).not.toThrow();
  });

  it('throws when context.initiatorOpenId is not declared in contextRefs', () => {
    expect(() => assertSavedWorkflowTemplateBindings(
      scheduleDag({ $ref: 'context.initiatorOpenId' }, true),
      {},
      ['larkAppId', 'chatId', 'chatType'],
    )).toThrow(/undeclared context initiatorOpenId/);
  });

  it('rejects a literal ownerOpenId value', () => {
    expect(() => assertSavedWorkflowTemplateBindings(
      scheduleDag('ou_literal', true),
      {},
      CONTEXT_REFS,
    )).toThrow(/input\.ownerOpenId must be exact/);
  });

  it('rejects a ${params.x} string marker for ownerOpenId', () => {
    expect(() => assertSavedWorkflowTemplateBindings(
      scheduleDag('${params.owner}', true),
      { owner: { type: 'string', required: true } },
      CONTEXT_REFS,
    )).toThrow(/input\.ownerOpenId must be exact/);
  });

  it('rejects a params $ref object for ownerOpenId', () => {
    expect(() => assertSavedWorkflowTemplateBindings(
      scheduleDag({ $ref: 'params.owner' }, true),
      { owner: { type: 'string', required: true } },
      CONTEXT_REFS,
    )).toThrow(/input\.ownerOpenId must be exact/);
  });

  it('rejects a cross-node result $ref for ownerOpenId', () => {
    expect(() => assertSavedWorkflowTemplateBindings(
      scheduleDag({ $ref: 'upstream.result.owner' }, true),
      {},
      CONTEXT_REFS,
    )).toThrow(/input\.ownerOpenId must be exact/);
  });

  it('rejects an exact $ref with an extra key for ownerOpenId', () => {
    expect(() => assertSavedWorkflowTemplateBindings(
      scheduleDag({ $ref: 'context.initiatorOpenId', extra: 1 }, true),
      {},
      CONTEXT_REFS,
    )).toThrow(/input\.ownerOpenId must be exact/);
  });
});
